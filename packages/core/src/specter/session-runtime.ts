export * as SpecterSessionRuntime from "./session-runtime.js"

import { Context, Deferred, Effect, Layer, Stream } from "effect"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import {
  StepHost,
  type AttemptOutcome,
  type CompactionOutcome,
  type DriveOutcome,
  type RecordFailure,
  type Runtime,
} from "@ocpp/runtime"
import { Bus } from "../bus.js"
import { ExternalAgentSession } from "../external-agent/session.js"
import { SessionEvent } from "../session/event.js"
import { SessionProjector } from "../session/projector.js"
import { SessionSchema } from "../session/schema.js"
import { SpecterStepHost } from "./step-host.js"

const CONTINUE_AFTER_RESTART =
  "The server restarted while you were working. Continue from where you left off without repeating completed work."

/**
 * The Sessions OC++'s one Specter runtime runs. The Bus composes the runtime, since every fact it records
 * goes through it; this binds OC++'s step I/O to it and starts its Reactions, once the projections that
 * fold their facts are registered. It learns about Sessions from the log: session-created is a fact the
 * runtime's own Commands record.
 */
export interface Interface {
  readonly runtime: Runtime
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

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const runtime = bus.runtime
    // The executions a stopped process left running, as the runtime found them at boot.
    const left = yield* Deferred.make<Set<SessionSchema.ID>>()

    // Resolves once the runtime's state says so: no execution is active (settled), and also none is about
    // to start from input that wakes the Session (idle; OC++'s runner coalesced that into the busy period).
    const awaitStatus = (sessionID: SessionSchema.ID, idle: boolean) =>
      runtime.subscribe({ type: "sessionStatus", payload: { sessionID } }).pipe(
        Stream.filter((status) => status.status !== "active" && (!idle || status.wakes !== true)),
        Stream.take(1),
        Stream.runDrain,
        Effect.orDie,
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

    // Reactions start now: OC++'s projections are registered, so whatever they record is projected.
    yield* runtime.start(interruptible).pipe(Effect.orDie)
    const active = runtime.query({ type: "activeSessions", payload: {} }).pipe(
      Effect.orDie,
      Effect.map((result) => new Set(result.sessionIDs.map((id) => SessionSchema.ID.make(id)))),
    )
    yield* Deferred.succeed(left, yield* active)

    return Service.of({
      runtime,
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
  // The runtime's Reactions record Session facts; their projections are registered before they start.
  deps: [Bus.node, SessionProjector.node, ExternalAgentSession.node, SpecterStepHost.node],
})
