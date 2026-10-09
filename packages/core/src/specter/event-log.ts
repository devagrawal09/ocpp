export * as SpecterEventLog from "./event-log.js"

import { and, asc, between, desc, eq, gt, inArray } from "drizzle-orm"
import { Effect } from "effect"
import {
  EventLogFailure,
  SpecterVersionConflictError,
  type EventDraft,
  type EventLogCommit,
  type EventLogService,
  type PersistedEvent,
} from "@specter/agent-runtime"
import type { Database } from "../database/database.js"
import { SpecterCommitTable, SpecterEventTable } from "./sql.js"

type DatabaseService = Database.Interface["db"]

export interface Hooks {
  /** IDs for a commit's events: the Bus event IDs the publisher chose, so both logs name an event alike. */
  readonly eventIDs: (idempotencyKey: string | undefined, count: number) => readonly string[]
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

  const append = (
    drafts: readonly EventDraft[],
    options: { expectedVersion?: number; idempotencyKey?: string; fingerprint?: string } = {},
  ) =>
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
            const ids = hooks.eventIDs(options.idempotencyKey, drafts.length)
            const recordedAt = new Date().toISOString()
            const rows = yield* db
              .insert(SpecterEventTable)
              .values(
                drafts.map((draft, index) => ({
                  id: ids[index]!,
                  type: draft.type,
                  payload: draft.payload,
                  recorded_at: recordedAt,
                })),
              )
              .returning({ order: SpecterEventTable.order })
              .all()
            const events = drafts.map(
              (draft, index): PersistedEvent => ({ ...draft, id: ids[index]!, order: rows[index]!.order, recordedAt }),
            )
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
    query: (afterOrder, eventTypes) =>
      eventTypes.length === 0
        ? Effect.succeed([])
        : db
            .select()
            .from(SpecterEventTable)
            .where(and(gt(SpecterEventTable.order, afterOrder), inArray(SpecterEventTable.type, [...eventTypes])))
            .orderBy(asc(SpecterEventTable.order))
            .all()
            .pipe(
              Effect.map((rows) => rows.map(toEvent)),
              Effect.catch(fail("query")),
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
