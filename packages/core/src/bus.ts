export * as Bus from "./bus.js"

import { Cause, Clock, Context, Effect, Layer, Option, PubSub, Schema, Stream } from "effect"
import { Event } from "@ocpp/schema/event"
import type { EventLog } from "@ocpp/schema/event-log"
import { and, asc, eq, gt, lte, sql, type SQL } from "drizzle-orm"
import { Database } from "./database/database.js"
import { EventSequenceTable, EventTable } from "./event/sql.js"
import { SpecterEventTable } from "./specter/sql.js"
import type { Location } from "@ocpp/schema/location"
import { KeyedMutex } from "./effect/keyed-mutex.js"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { Durable, DurableEventManifest } from "@ocpp/schema/durable-event-manifest"
import { SessionEvent } from "@ocpp/schema/session-event"
import type { SessionID } from "@ocpp/schema/session-id"
import { AbsolutePath } from "@ocpp/schema/schema"
import {
  type EventLogService as SpecterEventLogContract,
  EventLog as SpecterEventLogService,
  makeSessionEventStore,
  type PersistedEvent,
  toSpecterEventType,
} from "@ocpp/session-runtime"
import { SpecterEventLog } from "./specter/event-log.js"
import { SpecterSnapshots } from "./specter/snapshots.js"
import { SpecterTranslate } from "./specter/translate.js"

/** Idempotency keys of the commits that register a Session the log predates with the runtime. */
export const registrationKeyPrefix = "register:"

export type Subscriber<D extends Event.Definition = Event.Definition> = (event: Event.Payload<D>) => Effect.Effect<void>
export type Unsubscribe = Effect.Effect<void>

export const latestSequence = Effect.fn("Bus.latestSequence")(function* (
  db: Database.Interface["db"],
  aggregateID: string,
) {
  const row = yield* db
    .select({ seq: EventSequenceTable.seq })
    .from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, aggregateID))
    .get()
    .pipe(Effect.orDie)
  return row?.seq ?? -1
})

export const reserveSequence = Effect.fn("Bus.reserveSequence")(function* (
  db: Database.Interface["db"],
  aggregateID: string,
  seq: number,
) {
  yield* db
    .insert(EventSequenceTable)
    .values([{ aggregate_id: aggregateID, seq }])
    .onConflictDoUpdate({
      target: EventSequenceTable.aggregate_id,
      set: { seq: sql`max(${EventSequenceTable.seq}, ${seq})` },
    })
    .run()
    .pipe(Effect.orDie)
})

export class InvalidDurableEventError extends Schema.TaggedError<InvalidDurableEventError>()(
  "Bus.InvalidDurableEvent",
  {
    type: Schema.String,
    message: Schema.String,
  },
) {}

const envelope = (aggregateID: string, seq: number, version: number) => ({
  aggregateID,
  seq: Event.Seq.make(seq),
  version: Event.Version.make(version),
})

/** An aggregate's event as its sequence index names it, with the fact in Specter's log it is. */
type Indexed = {
  readonly id: Event.ID
  readonly aggregateID: string
  readonly seq: number
  readonly created: number
  readonly type: string
  readonly fact: PersistedEvent
}

/**
 * The OC++ event an index entry names: the fact itself for an event archived in the log under its
 * versioned OC++ type, else the fact's translation that carries the entry's ID. Undefined for a type
 * this process cannot decode.
 */
const decodeIndexed = (
  entry: Indexed,
  translate: (fact: PersistedEvent) => readonly SpecterTranslate.WireEvent[],
): Event.Payload | undefined => {
  const definition = Durable.get(entry.type)
  if (!definition?.durable) return undefined
  const data =
    entry.fact.type === entry.type
      ? entry.fact.payload
      : translate(entry.fact).find((wire) => wire.id === entry.id)?.data
  if (data === undefined)
    throw new InvalidDurableEventError({
      type: entry.type,
      message: `Fact ${entry.fact.id} does not project as event ${entry.id}`,
    })
  return {
    id: entry.id,
    created: entry.created,
    type: definition.type,
    durable: envelope(entry.aggregateID, entry.seq, definition.durable.version),
    data: Schema.decodeUnknownSync(definition.data)(data),
  }
}

export const versionedType = Event.versionedType
export const durable = Event.durable
export const ephemeral = Event.ephemeral

export interface PublishOptions {
  readonly id?: Event.ID
  readonly metadata?: Record<string, unknown>
  readonly location?: Location.Ref
  readonly global?: boolean
  /** Local operational projection committed atomically with a new durable event. Not replayed or serialized. */
  readonly commit?: (seq: number) => Effect.Effect<void>
}

export type PublishInput<D extends Event.DurableDefinition = Event.DurableDefinition> = readonly [
  definition: D,
  data: Event.Data<D>,
  options?: PublishOptions,
]

export type PublishResult<I extends readonly PublishInput[]> = {
  readonly [K in keyof I]: I[K] extends PublishInput<infer D> ? Event.Payload<D> : never
}

/** Marker/event union emitted by `log`. */
export type LogItem = Event.Payload | EventLog.Synced

export const isSynced = (item: LogItem): item is EventLog.Synced => item.type === "log.synced"

const mapNonEmpty = <A, B>(items: readonly [A, ...A[]], f: (item: A) => B): [B, ...B[]] => [
  f(items[0]),
  ...items.slice(1).map(f),
]

/** OC++'s durable events, which the Specter runtime records as facts in its Event Log. */
const recordedFacts = new Set<string>(DurableEventManifest.Definitions.map((definition) => definition.type))

export type SubscribePayload<D extends readonly Event.Definition[]> = D[number] extends infer Item
  ? Item extends Event.Definition
    ? Event.Payload<Item>
    : never
  : never

export interface Subscribe {
  /**
   * Volatile live channel: every event published from now on, nothing before or
   * across a disconnect. Consumers that need reliability combine it with `log`.
   * With an ambient Location, delivery is restricted to that Location and global
   * events. Unlocated Session events use the Session's owner at publication time.
   * Session moves reach both the old and new Location, without changing the event.
   */
  (): Stream.Stream<Event.Payload>
  <D extends Event.Definition>(definition: D): Stream.Stream<Event.Payload<D>>
  <const D extends readonly [Event.Definition, ...Event.Definition[]]>(
    definitions: D,
  ): Stream.Stream<SubscribePayload<D>>
}

const isDefinition = (input: Event.Definition | readonly Event.Definition[]): input is Event.Definition =>
  !Array.isArray(input)

export interface Interface {
  readonly publish: <D extends Event.Definition>(
    definition: D,
    data: Event.Data<D>,
    options?: PublishOptions,
  ) => Effect.Effect<Event.Payload<D>>
  readonly publishAll: <const I extends readonly [PublishInput, ...PublishInput[]]>(
    events: I,
  ) => Effect.Effect<PublishResult<I>>
  readonly subscribe: Subscribe
  /**
   * Durable, ordered per-aggregate log read. Forked aggregates may reserve an
   * inherited prefix before their first child-authored event. `follow: false`
   * completes at the end of the log; `follow: true` replays then transitions
   * to live. Both modes emit one `Synced` marker at the captured replay
   * watermark.
   */
  readonly log: (input: {
    readonly aggregateID: string
    readonly after?: number
    readonly follow?: boolean
  }) => Stream.Stream<LogItem>
  /** @deprecated Use `subscribe()` and consume the returned stream. */
  readonly listen: (listener: Subscriber) => Effect.Effect<Unsubscribe>
  readonly project: <D extends Event.Definition>(definition: D, projector: Subscriber<D>) => Effect.Effect<void>
  /**
   * Projects events again from Specter's log, in order: their projectors only, not commit hooks or
   * listeners. One aggregate's, or with none every aggregate's, in the order the log recorded them, while
   * nothing else records. The caller clears the read models first.
   */
  readonly rebuild: (aggregateID?: string) => Effect.Effect<void>
  readonly remove: (aggregateID: string) => Effect.Effect<void>
  /**
   * Specter's Event Log in this database, for the runtime that runs Sessions. Facts its Commands record
   * are projected here as OC++ events, in the same transaction, and notified once it commits. A commit
   * whose idempotency key starts with `registrationKeyPrefix` is not projected.
   */
  readonly specterLog: Effect.Effect<SpecterEventLogContract>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/Bus") {}

interface Options {
  readonly beforeAggregateRead?: (aggregateID: string) => Effect.Effect<void>
  /** Maximum durable rows read per page while replaying or tailing an aggregate log. */
  readonly logReadPageSize?: number
}

export function configured(options?: Options) {
  return makeGlobalNode({
    service: Service,
    deps: [Database.node],
    layer: Layer.effect(
      Service,
      Effect.gen(function* () {
        // Deferred import: a static one would close the module cycle
        // bus → location → project → bus and hit the node bindings in TDZ.
        const { Location } = yield* Effect.promise(() => import("./location.js"))
        const { SessionTable } = yield* Effect.promise(() => import("./session/sql.js"))
        const pubsub = {
          live: yield* PubSub.unbounded<Event.Payload>(),
          durable: new Map<string, Set<PubSub.PubSub<void>>>(),
          typed: new Map<string, PubSub.PubSub<Event.Payload>>(),
        }
        const projectors = new Map<string, Subscriber[]>()
        const listeners = new Array<Subscriber>()
        const durableLocks = KeyedMutex.makeUnsafe<string>()
        const { db } = yield* Database.Service
        const logReadPageSize = options?.logReadPageSize ?? 512
        const sessions = new Map<SessionID, Location.Ref>()
        // Keep routing separate from the public event, and retain its snapshot
        // while a slow subscriber drains events queued before a move or deletion.
        const routes = new WeakMap<Event.Payload, readonly Location.Ref[]>()

        const isSessionEvent = (event: Event.Payload): event is SessionEvent.Event =>
          Object.hasOwn(SessionEvent.All.cases, event.type)

        const prepareRoutes = Effect.fnUntraced(function* (events: readonly Event.Payload[]) {
          const updates = new Map<SessionID, Location.Ref | undefined>()
          const resolved = new Map<Event.Payload, readonly Location.Ref[]>()
          for (const event of events) {
            if (!isSessionEvent(event)) continue
            const id = event.data.sessionID
            if (event.type === "session.created") {
              updates.set(id, event.data.location)
              resolved.set(event, [event.location ?? event.data.location])
              continue
            }
            if (event.location && event.type !== "session.forked" && event.type !== "session.moved") {
              if (event.type === "session.deleted") updates.set(id, undefined)
              continue
            }
            const owner = event.type === "session.forked" ? event.data.parentID : id
            let ref = updates.has(owner) ? updates.get(owner) : sessions.get(owner)
            if (!ref && !updates.has(owner)) {
              const row = yield* db
                .select({ directory: SessionTable.directory, workspaceID: SessionTable.workspace_id })
                .from(SessionTable)
                .where(eq(SessionTable.id, owner))
                .get()
                .pipe(Effect.orDie)
              ref = row
                ? { directory: AbsolutePath.make(row.directory), workspaceID: row.workspaceID ?? undefined }
                : undefined
              updates.set(owner, ref)
            }
            if (event.type === "session.moved") {
              // Both owners need the transition, even if the producer supplied
              // an envelope location. Later events use only the destination.
              updates.set(id, event.data.location)
              resolved.set(event, ref ? [ref, event.data.location] : [event.data.location])
              continue
            }
            if (event.type === "session.forked") updates.set(id, ref)
            resolved.set(event, event.location ? [event.location] : ref ? [ref] : [])
            if (event.type === "session.deleted") updates.set(id, undefined)
          }
          // Apply only after the projection transaction commits. A failed move
          // must not redirect events away from the Session's actual location.
          return () => {
            for (const [id, ref] of updates) {
              if (ref) sessions.set(id, ref)
              else sessions.delete(id)
            }
            for (const [event, ref] of resolved) routes.set(event, ref)
          }
        })

        const getOrCreate = (definition: Event.Definition) =>
          Effect.gen(function* () {
            const existing = pubsub.typed.get(definition.type)
            if (existing) return existing
            const created = yield* PubSub.unbounded<Event.Payload>()
            pubsub.typed.set(definition.type, created)
            return created
          })

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* PubSub.shutdown(pubsub.live)
            yield* Effect.forEach(
              pubsub.durable.values(),
              (pubsubs) => Effect.forEach(pubsubs, PubSub.shutdown, { discard: true }),
              { discard: true },
            )
            yield* Effect.forEach(pubsub.typed.values(), PubSub.shutdown, { discard: true })
          }),
        )

        /** The aggregate of a durable event, which must be a fact OC++ records in Specter's log. */
        const recordable = (definition: Event.DurableDefinition, data: unknown) => {
          const aggregateID = (data as Record<string, unknown>)[definition.durable.aggregate]
          if (typeof aggregateID !== "string")
            return Effect.die(
              new InvalidDurableEventError({
                type: definition.type,
                message: `Expected string aggregate field ${definition.durable.aggregate}`,
              }),
            )
          if (!recordedFacts.has(definition.type))
            return Effect.die(
              new InvalidDurableEventError({
                type: definition.type,
                message: `${definition.type} is not in OC++'s inventory of recorded facts`,
              }),
            )
          return Effect.succeed(aggregateID)
        }

        function publishEvent<D extends Event.Definition>(
          definition: D,
          event: Event.Payload<D>,
          commit?: PublishOptions["commit"],
        ) {
          return Effect.gen(function* () {
            if (!definition.durable && commit)
              return yield* Effect.die(
                new InvalidDurableEventError({
                  type: event.type,
                  message: "Local commit hooks require a durable event",
                }),
              )
            if (definition.durable) {
              const aggregateID = yield* recordable(definition as Event.DurableDefinition, event.data)
              return yield* durableLocks.withLock(aggregateID)(
                Effect.gen(function* () {
                  // Recording is uninterruptible, as a commit was before; notifying listeners is not.
                  const recorded = yield* Effect.uninterruptible(
                    Effect.gen(function* () {
                      const committed = yield* recordFacts([
                        {
                          definition: definition as Event.DurableDefinition,
                          aggregateID,
                          commit,
                          event: event as Event.Payload,
                        },
                      ])
                      committed.route()
                      yield* Effect.forEach(
                        pubsub.durable.get(aggregateID) ?? [],
                        (wake) => PubSub.publish(wake, undefined),
                        { discard: true },
                      )
                      return committed.events[0] as Event.Payload<D>
                    }),
                  )
                  yield* notify(recorded as Event.Payload, true)
                  return recorded
                }),
              )
            }
            const route = yield* prepareRoutes([event as Event.Payload])
            route()
            yield* notify(event as Event.Payload, false)
            return event
          })
        }

        const observe = (event: Event.Payload, observer: (event: Event.Payload) => Effect.Effect<void>) =>
          Effect.suspend(() => observer(event)).pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterrupts(cause),
              (cause) => Effect.logError("Event listener failed", { eventID: event.id, eventType: event.type, cause }),
            ),
          )

        function notify(event: Event.Payload, isolateListeners: boolean) {
          return Effect.gen(function* () {
            yield* Effect.forEach(
              listeners,
              (listener) => (isolateListeners ? observe(event, listener) : listener(event)),
              { discard: true },
            )
            const typed = pubsub.typed.get(event.type)
            if (typed) yield* PubSub.publish(typed, event)
            yield* PubSub.publish(pubsub.live, event)
          })
        }

        function publish<D extends Event.Definition>(definition: D, data: Event.Data<D>, options?: PublishOptions) {
          return Effect.gen(function* () {
            const serviceLocation = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
            const location = options?.global
              ? undefined
              : (options?.location ??
                (serviceLocation
                  ? { directory: serviceLocation.directory, workspaceID: serviceLocation.workspaceID }
                  : undefined))
            return yield* publishEvent(
              definition,
              {
                id: options?.id ?? Event.ID.create(),
                created: yield* Clock.currentTimeMillis,
                ...(options?.metadata ? { metadata: options.metadata } : {}),
                type: definition.type,
                ...(location ? { location } : {}),
                data,
              } as Event.Payload<D>,
              options?.commit,
            )
          })
        }

        type BatchItem = {
          readonly definition: Event.DurableDefinition
          readonly aggregateID: string
          readonly commit?: PublishOptions["commit"]
          readonly event: Event.Payload
        }

        /**
         * Projects one commit of an aggregate's events: their sequence index, projectors and commit hooks.
         * Runs inside the caller's transaction (Specter's append); `orders` are the events' facts in the log.
         */
        const projectBatch = (
          aggregateID: string,
          payloads: readonly [BatchItem, ...BatchItem[]],
          orders: readonly number[],
        ) =>
          Effect.gen(function* () {
            const row = yield* db
              .select({ seq: EventSequenceTable.seq })
              .from(EventSequenceTable)
              .where(eq(EventSequenceTable.aggregate_id, aggregateID))
              .get()
              .pipe(Effect.orDie)
            const firstSeq = (row?.seq ?? -1) + 1
            const finalSeq = firstSeq + payloads.length - 1
            const queued = payloads.map((item, index) => ({
              ...item.event,
              durable: envelope(aggregateID, firstSeq + index, item.definition.durable.version),
            }))
            const route = yield* prepareRoutes(queued)
            for (const [index, item] of payloads.entries()) {
              const event = queued[index]
              for (const projector of projectors.get(
                versionedType(item.definition.type, item.definition.durable.version),
              ) ?? []) {
                yield* projector(event)
              }
              if (item.commit) yield* item.commit(firstSeq + index)
            }
            yield* db
              .insert(EventSequenceTable)
              .values([{ aggregate_id: aggregateID, seq: finalSeq }])
              // max: a projector in this commit may have reserved later sequences (a fork reserves its copied prefix).
              .onConflictDoUpdate({
                target: EventSequenceTable.aggregate_id,
                set: { seq: sql`max(${EventSequenceTable.seq}, ${finalSeq})` },
              })
              .run()
              .pipe(Effect.orDie)
            yield* db
              .insert(EventTable)
              .values(
                queued.map((event, index) => ({
                  id: event.id,
                  aggregate_id: aggregateID,
                  seq: firstSeq + index,
                  created: event.created,
                  type: versionedType(payloads[index]!.definition.type, payloads[index]!.definition.durable.version),
                  log_order: orders[index]!,
                })),
              )
              .run()
              .pipe(Effect.orDie)
            return { events: queued, route }
          })

        // Session facts are recorded by the Specter runtime into its Event Log, kept in this database. The
        // log's append runs projectBatch inside its own transaction, so a recorded fact and OC++'s read
        // models change together or not at all.
        type Pending = {
          readonly items: readonly [BatchItem, ...BatchItem[]]
          committed?: Effect.Success<ReturnType<typeof projectBatch>>
        }
        const pending = new Map<string, Pending>()
        const specterLog = SpecterEventLog.make(db, {
          eventIDs: (key, count) =>
            Array.from(
              { length: count },
              (_, index) =>
                (key === undefined ? undefined : pending.get(key)?.items[index]?.event.id) ?? Event.ID.create(),
            ),
          appended: (key, events) =>
            Effect.gen(function* () {
              const entry = key === undefined ? undefined : pending.get(key)
              // A publication through this Bus: publish and publishAll notify once it returns.
              if (entry) {
                entry.committed = yield* projectBatch(
                  entry.items[0].aggregateID,
                  entry.items,
                  events.map((event) => event.order),
                )
                return Effect.void
              }
              // Registering a Session the log predates repeats OC++'s own session.created: nothing to project.
              if (key?.startsWith(registrationKeyPrefix)) return Effect.void
              // A fact a runtime Command recorded directly: project its OC++ events here and notify
              // after the transaction commits.
              const created = Date.parse(events[0]?.recordedAt ?? "") || (yield* Clock.currentTimeMillis)
              type Placed = BatchItem & { readonly order: number }
              const items = events.flatMap((recorded) =>
                SpecterTranslate.toWire(recorded).map((wire): Placed => {
                  const aggregateID = (wire.data as Record<string, unknown>)[wire.definition.durable.aggregate]
                  if (typeof aggregateID !== "string")
                    throw new InvalidDurableEventError({
                      type: wire.definition.type,
                      message: `Expected string aggregate field ${wire.definition.durable.aggregate}`,
                    })
                  return {
                    definition: wire.definition,
                    aggregateID,
                    event: { id: wire.id, created, type: wire.definition.type, data: wire.data } as Event.Payload,
                    order: recorded.order,
                  }
                }),
              )
              const batches = new Map<string, Placed[]>()
              for (const item of items) batches.set(item.aggregateID, [...(batches.get(item.aggregateID) ?? []), item])
              const committed = yield* Effect.forEach([...batches.values()], (batch) =>
                projectBatch(
                  batch[0]!.aggregateID,
                  batch as [Placed, ...Placed[]],
                  batch.map((item) => item.order),
                ),
              )
              const aggregates = [...batches.keys()]
              // The log runs this uninterruptibly once the append commits; as for a publish, only
              // notifying listeners can be interrupted.
              return Effect.gen(function* () {
                for (const [index, aggregateID] of aggregates.entries()) {
                  committed[index]!.route()
                  yield* Effect.forEach(
                    pubsub.durable.get(aggregateID) ?? [],
                    (wake) => PubSub.publish(wake, undefined),
                    {
                      discard: true,
                    },
                  )
                }
                yield* Effect.interruptible(
                  Effect.forEach(
                    committed.flatMap((batch) => batch.events),
                    (event) => notify(event, true),
                    { discard: true },
                  ),
                )
              })
            }),
        })
        // The log the session runtime writes through. An append holds the locks of the Sessions it
        // records for, as a publish does, so listeners see each Session's events in order.
        const runtimeLog: SpecterEventLogContract = {
          ...specterLog,
          append: (drafts, options) =>
            [
              ...new Set(
                drafts.flatMap((draft) => {
                  const sessionID = (draft.payload as { readonly sessionID?: unknown } | undefined)?.sessionID
                  return typeof sessionID === "string" ? [sessionID] : []
                }),
              ),
            ]
              .sort()
              .reduce(
                (append, sessionID) => durableLocks.withLock(sessionID)(append),
                specterLog.append(drafts, options),
              ),
        }
        // Its Slice starts from its snapshot, as the session runtime's do.
        const store = yield* makeSessionEventStore({ slices: yield* SpecterSnapshots.persisted(db) }).pipe(
          Effect.provideService(SpecterEventLogService, specterLog),
          Effect.orDie,
        )
        const recordFacts = (items: readonly [BatchItem, ...BatchItem[]]) => {
          const key = `bus:${crypto.randomUUID()}`
          const entry: Pending = { items }
          return Effect.acquireUseRelease(
            Effect.sync(() => pending.set(key, entry)),
            () =>
              store
                .command(
                  {
                    type: "recordSessionFacts",
                    payload: {
                      facts: mapNonEmpty(items, (item) => ({
                        type: toSpecterEventType(item.definition.type),
                        payload: Schema.encodeUnknownSync(item.definition.data)(item.event.data),
                      })),
                    },
                  },
                  { idempotencyKey: key },
                )
                .pipe(
                  Effect.orDie,
                  Effect.map(() => entry.committed!),
                ),
            () => Effect.sync(() => pending.delete(key)),
          )
        }

        function publishAll<const I extends readonly [PublishInput, ...PublishInput[]]>(events: I) {
          return Effect.gen(function* () {
            const serviceLocation = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
            const payloads = yield* Effect.forEach(events, ([definition, data, options]) =>
              Effect.gen(function* () {
                const aggregateID = yield* recordable(definition, data)
                const location = options?.global
                  ? undefined
                  : (options?.location ??
                    (serviceLocation
                      ? { directory: serviceLocation.directory, workspaceID: serviceLocation.workspaceID }
                      : undefined))
                return {
                  definition,
                  aggregateID,
                  commit: options?.commit,
                  event: {
                    id: options?.id ?? Event.ID.create(),
                    created: yield* Clock.currentTimeMillis,
                    ...(options?.metadata ? { metadata: options.metadata } : {}),
                    type: definition.type,
                    ...(location ? { location } : {}),
                    data,
                  } as Event.Payload,
                }
              }),
            )
            const aggregateID = payloads[0].aggregateID
            if (payloads.some((item) => item.aggregateID !== aggregateID)) {
              return yield* Effect.die(
                new InvalidDurableEventError({
                  type: payloads[0].definition.type,
                  message: "Published events must belong to the same aggregate",
                }),
              )
            }
            return yield* durableLocks.withLock(aggregateID)(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  const committed = yield* recordFacts(payloads)
                  committed.route()
                  yield* Effect.forEach(
                    pubsub.durable.get(aggregateID) ?? [],
                    (wake) => PubSub.publish(wake, undefined),
                    {
                      discard: true,
                    },
                  )
                  yield* Effect.forEach(committed.events, (event) => notify(event, true), { discard: true })
                  return committed.events as PublishResult<I>
                }),
              ),
            )
          })
        }

        function remove(aggregateID: string) {
          return db
            .transaction(() =>
              Effect.gen(function* () {
                yield* db.delete(EventSequenceTable).where(eq(EventSequenceTable.aggregate_id, aggregateID)).run()
                yield* db.delete(EventTable).where(eq(EventTable.aggregate_id, aggregateID)).run()
              }),
            )
            .pipe(
              Effect.tap(() => Effect.sync(() => sessions.delete(aggregateID as SessionID))),
              Effect.orDie,
            )
        }

        const local = <A extends Event.Payload>(stream: Stream.Stream<A>) =>
          Stream.unwrap(
            Effect.serviceOption(Location.Service).pipe(
              Effect.map((location) =>
                Option.match(location, {
                  onNone: () => stream,
                  onSome: (location) => {
                    const matches = (ref: Location.Ref) =>
                      ref.directory === location.directory && ref.workspaceID === location.workspaceID
                    return stream.pipe(
                      Stream.filter((event) => {
                        const refs = routes.get(event)
                        if (refs) return refs.some(matches)
                        return !event.location || matches(event.location)
                      }),
                    )
                  },
                }),
              ),
            ),
          )

        function subscribe(): Stream.Stream<Event.Payload>
        function subscribe<D extends Event.Definition>(definition: D): Stream.Stream<Event.Payload<D>>
        function subscribe<const D extends readonly [Event.Definition, ...Event.Definition[]]>(
          definitions: D,
        ): Stream.Stream<SubscribePayload<D>>
        function subscribe(input?: Event.Definition | readonly Event.Definition[]): Stream.Stream<Event.Payload> {
          if (input === undefined) return streamLive()
          if (isDefinition(input)) {
            return local(Stream.unwrap(getOrCreate(input).pipe(Effect.map((pubsub) => Stream.fromPubSub(pubsub)))))
          }
          const types = new Set(input.map((definition) => definition.type))
          return streamLive().pipe(Stream.filter((event) => types.has(event.type)))
        }

        const streamLive = (): Stream.Stream<Event.Payload> => local(Stream.fromPubSub(pubsub.live))

        // An aggregate's events after a sequence, read from Specter's log through their sequence index.
        // Indexed events read from Specter's log, each decoded as OC++ recorded it. Types missing from the
        // durable manifest are skipped instead of failing the read: an aggregate may hold events this process
        // cannot decode. The raw rows keep cursors advancing across the resulting gaps. A fact projecting as
        // several events is translated once.
        const readIndex = (where: SQL, orderBy: readonly SQL[], limit: number) =>
          db
            .select({
              id: EventTable.id,
              aggregateID: EventTable.aggregate_id,
              seq: EventTable.seq,
              created: EventTable.created,
              type: EventTable.type,
              fact: {
                id: SpecterEventTable.id,
                order: SpecterEventTable.order,
                type: SpecterEventTable.type,
                payload: SpecterEventTable.payload,
                recordedAt: SpecterEventTable.recorded_at,
              },
            })
            .from(EventTable)
            .innerJoin(SpecterEventTable, eq(SpecterEventTable.order, EventTable.log_order))
            .where(where)
            .orderBy(...orderBy)
            .limit(limit)
            .all()
            .pipe(
              Effect.orDie,
              Effect.map((rows) => {
                const translations = new Map<number, readonly SpecterTranslate.WireEvent[]>()
                const translate = (fact: PersistedEvent) => {
                  const known = translations.get(fact.order)
                  if (known) return known
                  const wire = SpecterTranslate.toWire(fact)
                  translations.set(fact.order, wire)
                  return wire
                }
                return {
                  last: rows.at(-1),
                  events: rows.flatMap((row) => {
                    const event = decodeIndexed(row as Indexed, translate)
                    return event ? [event] : []
                  }),
                }
              }),
            )

        // An aggregate's events after a sequence, in sequence order.
        const readIndexed = (
          aggregateID: string,
          after: number,
          input: { readonly through: number; readonly limit: number },
        ) =>
          readIndex(
            and(
              eq(EventTable.aggregate_id, aggregateID),
              gt(EventTable.seq, after),
              lte(EventTable.seq, input.through),
            )!,
            [asc(EventTable.seq)],
            input.limit,
          ).pipe(Effect.map((page) => ({ seq: page.last?.seq, events: page.events })))

        const readAfter = (
          aggregateID: string,
          after: number,
          input: { readonly through: number; readonly limit: number },
        ) =>
          (options?.beforeAggregateRead?.(aggregateID) ?? Effect.void).pipe(
            Effect.andThen(Effect.suspend(() => readIndexed(aggregateID, after, input))),
          )

        const reproject = (events: readonly Event.Payload[]) =>
          Effect.forEach(
            events,
            (event) =>
              Effect.forEach(
                projectors.get(versionedType(event.type, event.durable!.version)) ?? [],
                (projector) => projector(event),
                { discard: true },
              ),
            { discard: true },
          )

        function rebuild(aggregateID?: string) {
          // One aggregate: its events in sequence order, under its lock.
          if (aggregateID !== undefined)
            return durableLocks.withLock(aggregateID)(
              db
                .transaction(
                  () =>
                    Effect.gen(function* () {
                      let after = -1
                      while (true) {
                        const page = yield* readIndexed(aggregateID, after, {
                          through: Number.MAX_SAFE_INTEGER,
                          limit: logReadPageSize,
                        })
                        if (page.seq === undefined) return
                        after = page.seq
                        yield* reproject(page.events)
                      }
                    }),
                  { behavior: "immediate" },
                )
                .pipe(Effect.orDie),
            )
          // Every aggregate: the whole log in the order it was recorded. A row may be projected before the
          // row it refers to, so references are checked when the rebuild commits.
          return db
            .transaction(
              () =>
                Effect.gen(function* () {
                  yield* db.run(sql`PRAGMA defer_foreign_keys = ON`).pipe(Effect.orDie)
                  let after: { readonly order: number; readonly seq: number; readonly id: string } | undefined
                  while (true) {
                    const page = yield* readIndex(
                      after === undefined
                        ? sql`1 = 1`
                        : sql`(${EventTable.log_order}, ${EventTable.seq}, ${EventTable.id}) > (${after.order}, ${after.seq}, ${after.id})`,
                      [asc(EventTable.log_order), asc(EventTable.seq), asc(EventTable.id)],
                      logReadPageSize,
                    )
                    if (!page.last) return
                    after = { order: page.last.fact.order, seq: page.last.seq, id: page.last.id }
                    yield* reproject(page.events)
                  }
                }),
              { behavior: "immediate" },
            )
            .pipe(Effect.orDie)
        }

        const subscribeDurable = (aggregateID: string) =>
          Effect.gen(function* () {
            const wake = yield* PubSub.sliding<void>(1)
            const subscription = yield* PubSub.subscribe(wake)
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                const wakes = pubsub.durable.get(aggregateID) ?? new Set()
                wakes.add(wake)
                pubsub.durable.set(aggregateID, wakes)
              }),
              () =>
                Effect.sync(() => {
                  const wakes = pubsub.durable.get(aggregateID)
                  wakes?.delete(wake)
                  if (wakes?.size === 0) pubsub.durable.delete(aggregateID)
                }).pipe(Effect.andThen(PubSub.shutdown(wake))),
            )
            return subscription
          })

        const log = (input: {
          readonly aggregateID: string
          readonly after?: number
          readonly follow?: boolean
        }): Stream.Stream<LogItem> =>
          Stream.unwrap(
            Effect.gen(function* () {
              let sequence = input.after ?? -1
              const readThrough = (through: number): Stream.Stream<Event.Payload> =>
                Stream.paginate(sequence, (cursor) =>
                  readAfter(input.aggregateID, cursor, { through, limit: logReadPageSize }).pipe(
                    Effect.tap((page) =>
                      Effect.sync(() => {
                        sequence = page.seq ?? sequence
                      }),
                    ),
                    Effect.map(
                      (page) =>
                        [
                          page.events,
                          page.seq !== undefined && page.seq < through ? Option.some(page.seq) : Option.none<number>(),
                        ] as const,
                    ),
                  ),
                )
              // Subscribing before the historical read means events committed during
              // replay either appear in the read or arrive through a post-marker wake.
              const wakes = input.follow ? yield* subscribeDurable(input.aggregateID) : undefined
              const target = yield* latestSequence(db, input.aggregateID)
              const marker: EventLog.Synced = {
                type: "log.synced",
                aggregateID: input.aggregateID,
                ...(target >= 0 ? { seq: Event.Seq.make(target) } : {}),
              }
              const replay: Stream.Stream<LogItem> = readThrough(target).pipe(Stream.concat(Stream.make(marker)))
              if (!wakes) return replay
              const live: Stream.Stream<LogItem> = Stream.fromSubscription(wakes).pipe(
                Stream.mapEffect(() => latestSequence(db, input.aggregateID)),
                Stream.filter((target) => target > sequence),
                Stream.flatMap((target) => readThrough(target)),
              )
              return Stream.concat(replay, live)
            }),
          )

        const listen = (listener: Subscriber): Effect.Effect<Unsubscribe> =>
          Effect.sync(() => {
            listeners.push(listener)
            return Effect.sync(() => {
              const index = listeners.indexOf(listener)
              if (index >= 0) listeners.splice(index, 1)
            })
          })

        const project = <D extends Event.Definition>(definition: D, projector: Subscriber<D>): Effect.Effect<void> =>
          Effect.sync(() => {
            const key = definition.durable
              ? versionedType(definition.type, definition.durable.version)
              : definition.type
            const list = projectors.get(key) ?? []
            list.push((event) => projector(event as Event.Payload<D>))
            projectors.set(key, list)
          })

        return Service.of({
          publish,
          publishAll,
          subscribe,
          log,
          listen,
          project,
          rebuild,
          remove,
          specterLog: Effect.succeed(runtimeLog),
        })
      }),
    ),
  })
}

export const node = configured()
