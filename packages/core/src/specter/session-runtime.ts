export * as SpecterSessionRuntime from "./session-runtime.js"

import { Context, Deferred, Duration, Effect, Layer, Stream } from "effect"
import { eq } from "drizzle-orm"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import {
  EventLog,
  makeEmbeddedSessionRuntime,
  SpecterCommandRejectedError,
  StepHost,
  type AttemptOutcome,
  type CompactionOutcome,
  type DriveExecutionOutboxStore,
  type DriveOutcome,
  type EmbeddedSessionRuntime,
  type RecordFailure,
  type ReactionOutboxStore,
  type RunStepOutboxStore,
} from "@ocpp/session-runtime"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { SessionEvent } from "../session/event.js"
import { SessionSchema } from "../session/schema.js"
import { SessionTable } from "../session/sql.js"
import { SessionStore } from "../session/store.js"
import { SpecterOutbox } from "./outbox.js"
import { SpecterSnapshots } from "./snapshots.js"
import { SpecterStepHost } from "./step-host.js"

type Payload<S> = S extends ReactionOutboxStore<infer T> ? T : never

const CONTINUE_AFTER_RESTART =
  "The server restarted while you were working. Continue from where you left off without repeating completed work."

/**
 * The embedded Specter runtime that runs whole Sessions. It writes to the same Event Log as the Bus,
 * which projects every fact it records as OC++ events in the same transaction, so OC++'s read models
 * and listeners stay in step without a forwarding hook. It learns about Sessions from the log too:
 * session.created is a fact the Bus records there.
 */
export interface Interface {
  readonly runtime: EmbeddedSessionRuntime
  /**
   * Records a Session with no session.created fact (a fork) with the runtime, once, before its first runtime
   * Command. Answers whether OC++ knows the Session.
   */
  readonly register: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Sessions with an execution the runtime has started and not yet settled, in any process. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Resolves once the runtime has no active execution for the Session, nor input about to start one. */
  readonly awaitIdle: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Resolves once the runtime has no active execution for the Session. */
  readonly awaitSettled: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /**
   * Stops the attempt or compaction this process runs for the Session, once it has recorded what it
   * produced (partial output, interrupted tools). Answers whether one was running.
   */
  readonly stop: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/SpecterSessionRuntime") {}

/** The rejection reason of a runtime Command, or undefined for any other failure. */
export const rejection = (error: unknown) =>
  error instanceof SpecterCommandRejectedError
    ? error.cause instanceof Error
      ? error.cause.message
      : String(error.cause)
    : undefined

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const db = (yield* Database.Service).db
    const log = yield* bus.specterLog
    // The executions a stopped process left running, as the runtime found them at boot.
    const left = yield* Deferred.make<Set<SessionSchema.ID>>()

    // Resolves once the runtime's state says so: no execution is active (settled), and also none is about
    // to start from input that wakes the Session (idle; OC++'s runner coalesced that into the busy period).
    let started: EmbeddedSessionRuntime | undefined
    const awaitStatus = (sessionID: SessionSchema.ID, idle: boolean) =>
      Effect.suspend(() =>
        started
          ? started.subscribe({ type: "sessionStatus", payload: { sessionID } }).pipe(
              Stream.filter((status) => status.status !== "active" && (!idle || status.wakes !== true)),
              Stream.take(1),
              Stream.runDrain,
              Effect.orDie,
            )
          : Effect.void,
      )
    const awaitIdle = (sessionID: SessionSchema.ID) => awaitStatus(sessionID, true)

    // An attempt stops when it is told to, before an interrupt is recorded, or once its execution
    // settles: either cancels the model stream and the tools it started, as in OC++'s own runner, and
    // the attempt records what it produced on the way out.
    const host = yield* StepHost
    const running = new Map<
      SessionSchema.ID,
      { readonly stop: Deferred.Deferred<void>; readonly done: Deferred.Deferred<void> }
    >()
    const untilIdle = <A, E>(sessionID: string, work: Effect.Effect<A, E>, stopped: A) =>
      Effect.gen(function* () {
        const id = SessionSchema.ID.make(sessionID)
        const entry = { stop: yield* Deferred.make<void>(), done: yield* Deferred.make<void>() }
        running.set(id, entry)
        return yield* Effect.raceFirst(
          work,
          Effect.raceFirst(Deferred.await(entry.stop), awaitStatus(id, false)).pipe(Effect.as(stopped)),
        ).pipe(
          Effect.ensuring(
            Effect.suspend(() => {
              if (running.get(id) === entry) running.delete(id)
              return Deferred.succeed(entry.done, undefined)
            }),
          ),
        )
      })
    const stop = (sessionID: SessionSchema.ID) =>
      Effect.suspend(() => {
        const entry = running.get(sessionID)
        if (!entry) return Effect.succeed(false)
        return Deferred.succeed(entry.stop, undefined).pipe(Effect.andThen(Deferred.await(entry.done)), Effect.as(true))
      })
    const interruptible = StepHost.of({
      begin: (input) =>
        host.begin(input).pipe(
          Effect.map((plan) =>
            "compact" in plan
              ? plan
              : {
                  ...plan,
                  run: (record) =>
                    untilIdle<AttemptOutcome, RecordFailure>(input.sessionID, plan.run(record), {
                      outcome: "stopped",
                    }),
                },
          ),
        ),
      compact: (input) =>
        untilIdle<CompactionOutcome, never>(input.sessionID, host.compact(input), { outcome: "stopped" }),
      ...(host.prepare ? { prepare: host.prepare } : {}),
      ...(host.moving ? { moving: host.moving } : {}),
      ...(host.recover ? { recover: host.recover } : {}),
      ...(host.drive
        ? {
            drive: (input: Parameters<NonNullable<typeof host.drive>>[0]) =>
              Effect.gen(function* () {
                const sessionID = SessionSchema.ID.make(input.sessionID)
                // A process that stopped left the execution running, and the agent hears why its turn goes on
                // before it continues. An execution the boot itself started from input recorded just before the
                // stop counts as left running too.
                const resumed = yield* Deferred.await(left)
                if (resumed.delete(sessionID))
                  yield* bus.publish(SessionEvent.Synthetic, {
                    sessionID,
                    text: CONTINUE_AFTER_RESTART,
                    description: "Continuing after restart",
                  })
                return yield* untilIdle<DriveOutcome, never>(input.sessionID, host.drive!(input), {
                  outcome: "stopped",
                })
              }),
          }
        : {}),
    })

    // The runtime keeps its state in OC++'s database, so a boot resumes from where the last one stopped:
    // its Slices from their snapshots, and its jobs from the outboxes, where a replayed delivery finds its
    // job instead of running again.
    const slices = yield* SpecterSnapshots.persisted(db)
    yield* SpecterOutbox.prune(db, Date.now() - Duration.toMillis(Duration.days(1))).pipe(Effect.orDie)
    const runStep = yield* SpecterOutbox.make<Payload<RunStepOutboxStore>>(db, "runStep").pipe(Effect.orDie)
    const drive = yield* SpecterOutbox.make<Payload<DriveExecutionOutboxStore>>(db, "driveExecution").pipe(Effect.orDie)

    // One step per Session at a time; different Sessions (subagents included) run at once.
    const runtime = yield* makeEmbeddedSessionRuntime({
      outbox: { worker: { concurrency: 64 } },
      stores: { slices, runStep, drive },
      // Every Slice holds the log's state once the runtime is up; from saved snapshots that is only the
      // log's tail.
      catchUp: true,
    }).pipe(
      Effect.provide(Layer.mergeAll(Layer.succeed(EventLog, log), Layer.succeed(StepHost, interruptible))),
      Effect.orDie,
    )
    started = runtime
    const active = runtime.query({ type: "activeSessions", payload: {} }).pipe(
      Effect.orDie,
      Effect.map((result) => new Set(result.sessionIDs.map((id) => SessionSchema.ID.make(id)))),
    )
    yield* Deferred.succeed(left, yield* active)

    const register = Effect.fn("SpecterSessionRuntime.register")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      const row = yield* db
        .select({ slug: SessionTable.slug, version: SessionTable.version })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!session || !row) return false
      yield* runtime
        .command(
          {
            type: "registerSession",
            payload: {
              sessionID,
              projectID: session.projectID,
              location: {
                directory: session.location.directory,
                ...(session.location.workspaceID === undefined ? {} : { workspaceID: session.location.workspaceID }),
              },
              slug: row.slug,
              version: row.version,
              ...(session.subpath === undefined ? {} : { subpath: session.subpath }),
              ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
              ...(session.title === undefined ? {} : { title: session.title }),
              ...(session.agent === undefined ? {} : { agent: session.agent }),
              ...(session.model === undefined ? {} : { model: session.model }),
              ...(session.metadata === undefined ? {} : { metadata: session.metadata }),
            },
          },
          // The Bus does not project this commit: OC++ projected the Session from its own fact.
          { idempotencyKey: `${Bus.registrationKeyPrefix}${sessionID}` },
        )
        .pipe(
          // A Session OC++ created is already known from its session.created fact.
          Effect.catchIf(
            (error) => rejection(error) === "Session already registered",
            () => Effect.void,
          ),
          Effect.orDie,
        )
      return true
    })
    const registered = new Set<SessionSchema.ID>()

    return Service.of({
      runtime,
      register: (sessionID) =>
        registered.has(sessionID)
          ? Effect.succeed(true)
          : register(sessionID).pipe(
              Effect.tap((known) =>
                Effect.sync(() => {
                  if (known) registered.add(sessionID)
                }),
              ),
            ),
      active,
      awaitIdle,
      awaitSettled: (sessionID) => awaitStatus(sessionID, false),
      stop,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Bus.node, Database.node, SessionStore.node, SpecterStepHost.node],
})
