export * as SpecterEventLog from "./event-log.js"

import { and, asc, between, desc, eq, gt, inArray, or } from "drizzle-orm"
import { Effect } from "effect"
import {
  EventLogFailure,
  SpecterVersionConflictError,
  type EventLogAppendCondition,
  type EventLogAppendOptions,
  type EventLogCommit,
  type EventLogDraft,
  type EventLogService,
  type PersistedEvent,
} from "@ocpp/runtime"
import type { Database } from "../database/database.js"
import { SpecterCommitTable, SpecterEventKeyTable, SpecterEventTable } from "./sql.js"

type DatabaseService = Database.Interface["db"]

export interface Hooks {
  /**
   * The identity of a commit's events: the IDs and creation times the Bus's dispatcher chose, so the log names and
   * dates an event as its dispatcher did. An event without a time (one a Reaction's own Command records) is recorded
   * at the time of the append.
   */
  readonly drafts: (
    idempotencyKey: string | undefined,
    count: number,
  ) => readonly { readonly id: string; readonly created?: number }[]
  /**
   * Runs inside the append transaction, after the events are stored: OC++ projects the commit there
   * (projectors, commit hooks, Bus sequences). A failure, defects included, rolls the append back, so
   * Specter's log and OC++'s read models never disagree. Returns what to do once the transaction has
   * committed (notify listeners); it runs uninterruptibly, so it marks what may be interrupted.
   */
  readonly appended: (
    idempotencyKey: string | undefined,
    events: readonly PersistedEvent[],
  ) => Effect.Effect<Effect.Effect<void>>
}

/** Specter's Event Log on OC++'s database. */
export const make = (db: DatabaseService, hooks: Hooks): EventLogService => {
  const fail = (operation: EventLogFailure["operation"]) => (cause: unknown) =>
    Effect.fail(new EventLogFailure(operation, cause))

  const toEvent = (row: typeof SpecterEventTable.$inferSelect): PersistedEvent => ({
    id: row.id,
    order: row.order,
    type: row.type,
    payload: row.payload,
    recordedAt: row.recorded_at,
  })

  const currentVersion = db
    .select({ order: SpecterEventTable.order })
    .from(SpecterEventTable)
    .orderBy(desc(SpecterEventTable.order))
    .limit(1)
    .get()
    .pipe(Effect.map((row) => row?.order ?? 0))

  const withEvents = (row: typeof SpecterCommitTable.$inferSelect) =>
    db
      .select()
      .from(SpecterEventTable)
      .where(between(SpecterEventTable.order, row.first_order, row.version))
      .orderBy(asc(SpecterEventTable.order))
      .all()
      .pipe(
        Effect.map(
          (events): EventLogCommit => ({
            events: events.map(toEvent),
            version: row.version,
            committedAt: row.committed_at,
            ...(row.idempotency_key === null ? {} : { idempotencyKey: row.idempotency_key }),
            ...(row.fingerprint === null ? {} : { fingerprint: row.fingerprint }),
          }),
        ),
      )

  const findCommit = (key: string) =>
    db
      .select()
      .from(SpecterCommitTable)
      .where(eq(SpecterCommitTable.idempotency_key, key))
      .get()
      .pipe(Effect.flatMap((row) => (row ? withEvents(row) : Effect.succeed(undefined))))

  const query = (afterOrder: number, eventTypes: readonly string[]) =>
    eventTypes.length === 0
      ? Effect.succeed([])
      : db
          .select()
          .from(SpecterEventTable)
          .where(and(gt(SpecterEventTable.order, afterOrder), inArray(SpecterEventTable.type, [...eventTypes])))
          .orderBy(asc(SpecterEventTable.order))
          .all()
          .pipe(Effect.map((rows) => rows.map(toEvent)))

  // The first fact appended after a decision read that it covers: one of its types, carrying one of its keys
  // when it names any. Checked in SQL, from the stored keys.
  const staleOrder = (condition: EventLogAppendCondition) => {
    const pairs = Object.entries(condition.keys ?? {}).filter(([, values]) => values.length > 0)
    if (condition.eventTypes.length === 0 || (condition.keys && pairs.length === 0)) return Effect.succeed(undefined)
    const types = inArray(SpecterEventTable.type, [...condition.eventTypes])
    if (!condition.keys)
      return db
        .select({ order: SpecterEventTable.order })
        .from(SpecterEventTable)
        .where(and(gt(SpecterEventTable.order, condition.afterOrder), types))
        .orderBy(asc(SpecterEventTable.order))
        .limit(1)
        .get()
        .pipe(Effect.map((row) => row?.order))
    return db
      .select({ order: SpecterEventKeyTable.order })
      .from(SpecterEventKeyTable)
      .innerJoin(SpecterEventTable, eq(SpecterEventTable.order, SpecterEventKeyTable.order))
      .where(
        and(
          gt(SpecterEventKeyTable.order, condition.afterOrder),
          types,
          or(
            ...pairs.map(([name, values]) =>
              and(eq(SpecterEventKeyTable.name, name), inArray(SpecterEventKeyTable.value, [...values])),
            ),
          ),
        ),
      )
      .orderBy(asc(SpecterEventKeyTable.order))
      .limit(1)
      .get()
      .pipe(Effect.map((row) => row?.order))
  }

  const append = (drafts: readonly EventLogDraft[], options: EventLogAppendOptions = {}) =>
    db
      .transaction(
        () =>
          Effect.gen(function* () {
            if (options.idempotencyKey) {
              const existing = yield* findCommit(options.idempotencyKey)
              if (existing) return { ...existing, duplicate: true, committed: Effect.void }
            }
            const version = yield* currentVersion
            if (options.expectedVersion !== undefined && options.expectedVersion !== version)
              return yield* fail("append")(new SpecterVersionConflictError(options.expectedVersion, version))
            // Stale when a fact the decision read landed after it read: one of its types, after its order,
            // carrying one of the keys it decided on when it names any.
            const unchanged = options.expectedUnchanged
            const stale = unchanged ? yield* staleOrder(unchanged) : undefined
            if (unchanged && stale !== undefined)
              return yield* fail("append")(new SpecterVersionConflictError(unchanged.afterOrder, stale))
            const recordedAt = new Date().toISOString()
            const identities = hooks.drafts(options.idempotencyKey, drafts.length).map((identity) => ({
              id: identity.id,
              recordedAt: identity.created === undefined ? recordedAt : new Date(identity.created).toISOString(),
            }))
            const rows = yield* db
              .insert(SpecterEventTable)
              .values(
                drafts.map((draft, index) => ({
                  id: identities[index]!.id,
                  type: draft.type,
                  payload: draft.payload,
                  recorded_at: identities[index]!.recordedAt,
                })),
              )
              .returning({ order: SpecterEventTable.order })
              .all()
            const events = drafts.map(
              (draft, index): PersistedEvent => ({
                type: draft.type,
                payload: draft.payload,
                ...identities[index]!,
                order: rows[index]!.order,
              }),
            )
            const keys = drafts.flatMap((draft, index) =>
              Object.entries(draft.keys).map(([name, value]) => ({ order: rows[index]!.order, name, value })),
            )
            if (keys.length > 0) yield* db.insert(SpecterEventKeyTable).values(keys).run()
            const committedVersion = events.at(-1)!.order
            yield* db
              .insert(SpecterCommitTable)
              .values({
                version: committedVersion,
                idempotency_key: options.idempotencyKey ?? null,
                fingerprint: options.fingerprint ?? null,
                first_order: events[0]!.order,
                committed_at: recordedAt,
              })
              .run()
            const committed = yield* hooks.appended(options.idempotencyKey, events)
            return {
              committed,
              events,
              version: committedVersion,
              committedAt: recordedAt,
              ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
              ...(options.fingerprint === undefined ? {} : { fingerprint: options.fingerprint }),
              duplicate: false,
            }
          }),
        { behavior: "immediate" },
      )
      .pipe(
        Effect.catch((cause) => (cause instanceof EventLogFailure ? Effect.fail(cause) : fail("append")(cause))),
        Effect.tap((result) => result.committed),
        // A committed append always runs its after-commit work.
        Effect.uninterruptible,
        Effect.map(({ committed: _, ...result }) => result),
      )

  return {
    capabilities: { scopedAppend: true, keyedRead: true },
    query: (afterOrder, eventTypes) => query(afterOrder, eventTypes).pipe(Effect.catch(fail("query"))),
    readKey: (key, page = {}) =>
      db
        .select({ event: SpecterEventTable })
        .from(SpecterEventKeyTable)
        .innerJoin(SpecterEventTable, eq(SpecterEventTable.order, SpecterEventKeyTable.order))
        .where(
          and(
            eq(SpecterEventKeyTable.name, key.name),
            eq(SpecterEventKeyTable.value, key.value),
            gt(SpecterEventKeyTable.order, page.afterOrder ?? 0),
          ),
        )
        .orderBy(asc(SpecterEventKeyTable.order))
        .limit(page.limit ?? -1)
        .all()
        .pipe(
          Effect.map((rows) => rows.map((row) => toEvent(row.event))),
          Effect.catch(fail("readKey")),
        ),
    currentVersion: currentVersion.pipe(Effect.catch(fail("currentVersion"))),
    commitsAfter: (afterVersion) =>
      db
        .select()
        .from(SpecterCommitTable)
        .where(gt(SpecterCommitTable.version, afterVersion))
        .orderBy(asc(SpecterCommitTable.version))
        .all()
        .pipe(
          Effect.flatMap((rows) => Effect.forEach(rows, withEvents)),
          Effect.catch(fail("commitsAfter")),
        ),
    findCommit: (key) => findCommit(key).pipe(Effect.catch(fail("findCommit"))),
    append,
  }
}
