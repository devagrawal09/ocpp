export * as Bus from "./bus.js"

import { Cause, Clock, Context, Duration, Effect, Layer, Option, PubSub, Schema, Stream } from "effect"
import { Event } from "@ocpp/schema/event"
import type { EventLog } from "@ocpp/schema/event-log"
import { and, asc, eq, gt, lte, sql, type SQL } from "drizzle-orm"
import { Database } from "./database/database.js"
import { EventSequenceTable, EventTable } from "./event/sql.js"
import { SpecterEventTable } from "./specter/tables.js"
import type { Location } from "@ocpp/schema/location"
import { KeyedMutex } from "./effect/keyed-mutex.js"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { DurableEventManifest } from "@ocpp/schema/durable-event-manifest"
import { SessionEvent } from "@ocpp/schema/session-event"
import type { SessionID } from "@ocpp/schema/session-id"
import { AbsolutePath } from "@ocpp/schema/schema"
import {
  type EventLogService as SpecterEventLogContract,
  EventLog as SpecterEventLogService,
  makeRuntime,
  persistSliceSnapshots,
  SpecterCommandRejectedError,
  type DriveExecutionOutboxStore,
  type PersistedEvent,
  type ReactionOutboxStore,
  type RunStepOutboxStore,
  type Runtime,
  type RuntimeCommand,
} from "@ocpp/runtime"
import {
  createSqliteEventLogService,
  createSqliteReactionOutboxStore,
  createSqliteSliceSnapshotStore,
} from "@ocpp/runtime/sqlite"
import { SpecterDatabase } from "./specter/database.js"

type OutboxPayload<S> = S extends ReactionOutboxStore<infer T> ? T : never

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

const envelope = (aggregateID: string, seq: number) => ({ aggregateID, seq: Event.Seq.make(seq) })

/** OC++'s durable events, each a fact in Specter's log under the same name. */
const durableDefinitions = new Map<string, Event.DurableDefinition>(
  DurableEventManifest.Definitions.map((definition) => [definition.type, definition]),
)

/** The definition of a fact in Specter's log: every fact is an OC++ event of the same name. */
const definitionOf = (fact: Pick<PersistedEvent, "id" | "type">) => {
  const definition = durableDefinitions.get(fact.type)
  if (!definition)
    throw new InvalidDurableEventError({
      type: fact.type,
      message: `Fact ${fact.id} is not in OC++'s inventory of recorded facts`,
    })
  return definition
}

/** The aggregate a fact belongs to: its definition names the payload field. */
const aggregateOf = (definition: Event.DurableDefinition, payload: unknown) => {
  const aggregateID = (payload as Record<string, unknown>)[definition.durable.aggregate]
  if (typeof aggregateID !== "string")
    throw new InvalidDurableEventError({
      type: definition.type,
      message: `Expected string aggregate field ${definition.durable.aggregate}`,
    })
  return aggregateID
}

/** A fact in Specter's log with its sequence in its aggregate, from the event index. */
type Indexed = {
  readonly aggregateID: string
  readonly seq: number
  readonly fact: Omit<PersistedEvent, "keys">
}

/** The event a fact is: its ID, its time, its payload decoded, and its place in its aggregate. */
const decodeIndexed = (entry: Indexed): Event.Payload => {
  const definition = definitionOf(entry.fact)
  return {
    id: Event.ID.make(entry.fact.id),
    created: Date.parse(entry.fact.recordedAt),
    type: definition.type,
    durable: envelope(entry.aggregateID, entry.seq),
    data: Schema.decodeUnknownSync(definition.data)(entry.fact.payload),
  }
}

export const durable = Event.durable
export const ephemeral = Event.ephemeral

export interface PublishOptions {
  readonly id?: Event.ID
  readonly metadata?: Record<string, unknown>
  readonly location?: Location.Ref
  readonly global?: boolean
}

/** How a fact a Command records is published: its envelope, and a write in its append transaction. */
export interface FactOptions extends PublishOptions {
  /** Local operational projection committed atomically with the fact. Not replayed or serialized. */
  readonly commit?: (seq: number) => Effect.Effect<void>
}

/** Marker/event union emitted by `log`. */
export type LogItem = Event.Payload | EventLog.Synced

export const isSynced = (item: LogItem): item is EventLog.Synced => item.type === "log-synced"

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
  /**
   * Publishes an ephemeral event: notified, never recorded. A durable fact is recorded only by a runtime
   * Command (`command`), so publishing one is a defect.
   */
  readonly publish: <D extends Event.Definition>(
    definition: D,
    data: Event.Data<D>,
    options?: PublishOptions,
  ) => Effect.Effect<Event.Payload<D>>
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
   * Dispatches one of the runtime's Commands, the only way a durable fact is recorded. Each fact it records
   * takes the options at its position (its ID, metadata, Location and commit hook), the ambient Location and
   * the time of the dispatch, and is projected in the append transaction and notified once it commits. Answers
   * the events the Command recorded, in order, or fails with its rejection.
   */
  readonly command: (
    command: RuntimeCommand,
    options?: CommandOptions,
  ) => Effect.Effect<readonly Event.Payload[], SpecterCommandRejectedError>
  /**
   * OC++'s one Specter runtime, over Specter's Event Log in this database: its Queries, and the start of its
   * Reactions once the Session runtime binds the step I/O. Its Commands are dispatched through `command`. Each
   * commit is projected here as OC++ events in the append transaction and notified once it commits; a commit
   * the Reactions' own Commands make takes the log's time and no Location.
   */
  readonly runtime: Pick<Runtime, "query" | "subscribe" | "start">
}

/** A production Command of the runtime: a test's runtime also takes recordHistory, which the Bus's type never names. */
export type { RuntimeCommand }

export interface CommandOptions {
  /** The options of the facts the Command records, by position. */
  readonly facts?: ReadonlyArray<FactOptions | undefined>
  /**
   * Waits for the Reactions the commit starts before answering, as a dispatcher that must see what its input
   * started does (input that wakes its Session).
   */
  readonly reactions?: boolean
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/Bus") {}

interface Options {
  readonly beforeAggregateRead?: (aggregateID: string) => Effect.Effect<void>
  /** Maximum durable rows read per page while replaying or tailing an aggregate log. */
  readonly logReadPageSize?: number
  /**
   * Tests only: the runtime registers `recordHistory`, which records facts as given, so a test can set up the
   * history Commands would have recorded. Production never makes the runtime with it.
   */
  readonly history?: boolean
}

/**
 * A Command dispatched through the Bus: when and where it was dispatched and the options of the facts it records,
 * by position. It travels to the log's append as each fact's context, and holds what the append projected.
 */
class Dispatch {
  recorded?: readonly Event.Payload[]

  constructor(
    readonly created: number,
    readonly location: Location.Ref | undefined,
    readonly facts: ReadonlyArray<FactOptions | undefined>,
    // Notifies as interruptibly as the dispatcher is: a dispatch from a finalizer notifies whole.
    readonly restore: <A>(effect: Effect.Effect<A>) => Effect.Effect<A>,
  ) {}
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
            if (event.type === "session-created") {
              updates.set(id, event.data.location)
              resolved.set(event, [event.location ?? event.data.location])
              continue
            }
            if (event.location && event.type !== "session-forked" && event.type !== "session-moved") {
              if (event.type === "session-deleted") updates.set(id, undefined)
              continue
            }
            const owner = event.type === "session-forked" ? event.data.parentID : id
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
            if (event.type === "session-moved") {
              // Both owners need the transition, even if the producer supplied
              // an envelope location. Later events use only the destination.
              updates.set(id, event.data.location)
              resolved.set(event, ref ? [ref, event.data.location] : [event.data.location])
              continue
            }
            if (event.type === "session-forked") updates.set(id, ref)
            resolved.set(event, event.location ? [event.location] : ref ? [ref] : [])
            if (event.type === "session-deleted") updates.set(id, undefined)
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

        // Only an ephemeral event is published; a durable fact is a Command's to record.
        function publishEvent<D extends Event.Definition>(definition: D, event: Event.Payload<D>) {
          return Effect.gen(function* () {
            if (definition.durable)
              return yield* Effect.die(
                new InvalidDurableEventError({
                  type: event.type,
                  message: `${event.type} is a durable fact, which only a runtime Command records (Bus.command)`,
                }),
              )
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
            return yield* publishEvent(definition, {
              id: options?.id ?? Event.ID.create(),
              created: yield* Clock.currentTimeMillis,
              ...(options?.metadata ? { metadata: options.metadata } : {}),
              type: definition.type,
              ...(location ? { location } : {}),
              data,
            } as Event.Payload<D>)
          })
        }

        type BatchItem = {
          readonly definition: Event.DurableDefinition
          readonly aggregateID: string
          readonly commit?: FactOptions["commit"]
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
              durable: envelope(aggregateID, firstSeq + index),
            }))
            const route = yield* prepareRoutes(queued)
            for (const [index, item] of payloads.entries()) {
              const event = queued[index]
              for (const projector of projectors.get(item.definition.type) ?? []) {
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
                queued.map((_, index) => ({
                  log_order: orders[index]!,
                  aggregate_id: aggregateID,
                  seq: firstSeq + index,
                })),
              )
              .run()
              .pipe(Effect.orDie)
            return { events: queued, route }
          })

        // The runtime's state lives in this database, in Specter's own SQLite stores.
        const database = SpecterDatabase.make(db)
        // Every fact is recorded by the Specter runtime into its Event Log, kept in this database. The
        // log's append runs projectBatch inside its own transaction, so a recorded fact and OC++'s read
        // models change together or not at all. A Command dispatched through this Bus gives each fact it records
        // its Dispatch as context: the fact's ID and time, and its options by position and where it was
        // dispatched. One a Reaction dispatches itself records its facts at the log's time, without a Location.
        const specterLog = createSqliteEventLogService(database, {
          eventId: () => Event.ID.create(),
          onAppend: ({ commit, metadata }) =>
            Effect.gen(function* () {
              // Project each fact as the event it is here, and notify after the transaction commits. A Command
              // dispatched through this Bus publishes them with its options.
              const dispatch = metadata.find((context) => context instanceof Dispatch)
              type Placed = BatchItem & { readonly order: number }
              const items = commit.events.map((recorded, index): Placed => {
                const definition = definitionOf(recorded)
                const options = dispatch?.facts[index]
                const location = options?.global ? undefined : (options?.location ?? dispatch?.location)
                return {
                  definition,
                  aggregateID: aggregateOf(definition, recorded.payload),
                  commit: options?.commit,
                  event: {
                    id: Event.ID.make(recorded.id),
                    created: Date.parse(recorded.recordedAt),
                    ...(options?.metadata ? { metadata: options.metadata } : {}),
                    type: definition.type,
                    ...(location ? { location } : {}),
                    data: Schema.decodeUnknownSync(definition.data)(recorded.payload),
                  } as Event.Payload,
                  order: recorded.order,
                }
              })
              const batches = new Map<string, Placed[]>()
              for (const item of items) batches.set(item.aggregateID, [...(batches.get(item.aggregateID) ?? []), item])
              const committed = yield* Effect.forEach([...batches.values()], (batch) =>
                projectBatch(
                  batch[0]!.aggregateID,
                  batch as [Placed, ...Placed[]],
                  batch.map((item) => item.order),
                ).pipe(
                  Effect.map((projected) => ({
                    ...projected,
                    placed: projected.events.map((event, index) => ({ event, order: batch[index]!.order })),
                  })),
                ),
              )
              if (dispatch)
                dispatch.recorded = committed
                  .flatMap((batch) => batch.placed)
                  .toSorted((left, right) => left.order - right.order)
                  .map((placed) => placed.event)
              const aggregates = [...batches.keys()]
              // The log runs this uninterruptibly once the append commits; only notifying listeners can be
              // interrupted.
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
                yield* (dispatch?.restore ?? Effect.interruptible)(
                  Effect.forEach(
                    committed.flatMap((batch) => batch.events),
                    (event) => notify(event, true),
                    { discard: true },
                  ),
                )
              })
            }),
        })
        // An append holds the locks of the aggregates it records for, so listeners see each aggregate's events
        // in order, and an aggregate's rebuild sees none recorded meanwhile.
        const runtimeLog: SpecterEventLogContract = {
          ...specterLog,
          append: (drafts, options) =>
            [
              ...new Set(
                drafts.flatMap((draft) => {
                  const definition = durableDefinitions.get(draft.type)
                  const aggregateID = definition
                    ? (draft.payload as Record<string, unknown> | undefined)?.[definition.durable.aggregate]
                    : undefined
                  return typeof aggregateID === "string" ? [aggregateID] : []
                }),
              ),
            ]
              .sort()
              .reduce(
                (append, aggregateID) => durableLocks.withLock(aggregateID)(append),
                specterLog.append(drafts, options),
              ),
        }
        // The runtime keeps its state in this database too, so a boot resumes from where the last one
        // stopped: its Slices from their snapshots, saved every minute and once the runtime (made after them)
        // has closed, and its Reactions' jobs from their outbox queues, where a replayed delivery finds its job
        // instead of running again.
        const slices = yield* persistSliceSnapshots(createSqliteSliceSnapshotStore(database)).pipe(Effect.orDie)
        const runStep = createSqliteReactionOutboxStore<OutboxPayload<RunStepOutboxStore>>(database, {
          queue: "runStep",
        })
        const drive = createSqliteReactionOutboxStore<OutboxPayload<DriveExecutionOutboxStore>>(database, {
          queue: "driveExecution",
        })
        // This process is the outboxes' only worker: the jobs the last one left unfinished run again at once, with
        // a fresh retry budget, as replaying them into an empty outbox did, and jobs completed over a day ago go. A
        // delivery that old is behind its Reaction's snapshot; replayed anyway, its job runs again and finds its
        // Commands recorded.
        const now = Date.now()
        yield* Effect.forEach(
          [runStep, drive],
          (outbox) =>
            outbox
              .release(new Date(now), { deadLetters: true })
              .pipe(Effect.andThen(outbox.prune(new Date(now - Duration.toMillis(Duration.days(1)))))),
          { discard: true },
        ).pipe(Effect.orDie)
        const runtime = yield* makeRuntime({
          // One step per Session at a time; different Sessions (subagents included) run at once.
          outbox: { worker: { concurrency: 64 } },
          stores: { slices: slices.layer, runStep, drive },
          // Every Slice holds the log's state once the runtime is up; from saved snapshots that is only the
          // log's tail.
          catchUp: true,
          ...(options?.history ? { history: true } : {}),
        }).pipe(Effect.provideService(SpecterEventLogService, runtimeLog), Effect.orDie)
        // Recording is uninterruptible; notifying listeners, and waiting for the Reactions, is as interruptible
        // as the dispatcher.
        const command: Interface["command"] = (envelope, options) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const serviceLocation = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
              const dispatch = new Dispatch(
                yield* Clock.currentTimeMillis,
                serviceLocation
                  ? { directory: serviceLocation.directory, workspaceID: serviceLocation.workspaceID }
                  : undefined,
                options?.facts ?? [],
                restore,
              )
              const recordedAt = new Date(dispatch.created).toISOString()
              const execution = yield* runtime
                .command(envelope, {
                  // Each fact is named and dated as its dispatcher chose, and carries the dispatch to the log's
                  // append, which projects and notifies it with the options at its position.
                  eventContext: (_, index) => ({
                    id: dispatch.facts[index]?.id ?? Event.ID.create(),
                    recordedAt,
                    metadata: dispatch,
                  }),
                })
                .pipe(
                  Effect.catch((error) =>
                    error instanceof SpecterCommandRejectedError ? Effect.fail(error) : Effect.die(error),
                  ),
                )
              if (options?.reactions) yield* restore(execution.reactions.pipe(Effect.orDie))
              return dispatch.recorded ?? []
            }),
          )

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

        // Indexed events read from Specter's log through their sequence index, each its fact.
        const readIndex = (where: SQL, orderBy: readonly SQL[], limit: number) =>
          db
            .select({
              aggregateID: EventTable.aggregate_id,
              seq: EventTable.seq,
              fact: {
                id: SpecterEventTable.id,
                order: SpecterEventTable.event_order,
                type: SpecterEventTable.type,
                payload: SpecterEventTable.payload,
                recordedAt: SpecterEventTable.recorded_at,
              },
            })
            .from(EventTable)
            .innerJoin(SpecterEventTable, eq(SpecterEventTable.event_order, EventTable.log_order))
            .where(where)
            .orderBy(...orderBy)
            .limit(limit)
            .all()
            .pipe(
              Effect.orDie,
              Effect.map((rows) => ({
                last: rows.at(-1),
                events: rows.map((row) => decodeIndexed(row as Indexed)),
              })),
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
              Effect.forEach(projectors.get(event.type) ?? [], (projector) => projector(event), { discard: true }),
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
                  let after: number | undefined
                  while (true) {
                    const page = yield* readIndex(
                      after === undefined ? sql`1 = 1` : gt(EventTable.log_order, after),
                      [asc(EventTable.log_order)],
                      logReadPageSize,
                    )
                    if (!page.last) return
                    after = page.last.fact.order
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
                type: "log-synced",
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
            const list = projectors.get(definition.type) ?? []
            list.push((event) => projector(event as Event.Payload<D>))
            projectors.set(definition.type, list)
          })

        return Service.of({
          publish,
          command,
          subscribe,
          log,
          listen,
          project,
          rebuild,
          remove,
          runtime: { query: runtime.query, subscribe: runtime.subscribe, start: runtime.start },
        })
      }),
    ),
  })
}

export const node = configured()
