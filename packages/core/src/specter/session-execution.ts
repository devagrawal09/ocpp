export * as SpecterSessionExecution from "./session-execution.js"

import { Effect, Layer } from "effect"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { ExternalAgentSession } from "../external-agent/session.js"
import { Job } from "../job.js"
import { StepFailedError } from "../session/error.js"
import { SessionExecution } from "../session/execution.js"
import { SessionSchema } from "../session/schema.js"
import { rejection, SpecterSessionRuntime } from "./session-runtime.js"

/**
 * `SessionExecution.Service` when the embedded Specter runtime runs Sessions. A recorded input wakes
 * the runtime through its own Reaction unless it was admitted held (`resume: false`); `wake` starts an
 * execution for held input too. A Session whose model selects an external agent runs on the runtime as
 * well: the runtime starts, settles and interrupts its executions, and OC++'s external agent harness
 * drives each one (the host's `drive`).
 */
export const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const specter = yield* SpecterSessionRuntime.Service
    const jobs = yield* Job.Service

    // Starts an execution unless one is active. A rejection means it is already running.
    const start = (sessionID: SessionSchema.ID) =>
      specter.runtime.command({ type: "startExecution", payload: { sessionID } }).pipe(
        Effect.flatMap((execution) => execution.reactions),
        Effect.catch((error) => (rejection(error) === undefined ? Effect.die(error) : Effect.void)),
      )

    return SessionExecution.Service.of({
      active: specter.active,
      isActive: (sessionID) => specter.active.pipe(Effect.map((active) => active.has(sessionID))),
      wake: Effect.fn("SpecterSessionExecution.wake")(function* (sessionID: SessionSchema.ID) {
        yield* specter.register(sessionID)
        // Nothing to deliver: no execution, as in OC++'s runner.
        const next = yield* specter.runtime
          .query({ type: "nextDeliverable", payload: { sessionID, boundary: "idle" } })
          .pipe(Effect.orDie)
        if (next.item !== null) yield* start(sessionID)
      }),
      // Runs the Session until it is idle and fails as its execution did, as OC++'s runner's resume does.
      resume: Effect.fn("SpecterSessionExecution.resume")(function* (sessionID: SessionSchema.ID) {
        yield* specter.register(sessionID)
        yield* start(sessionID)
        // The execution this call started or joined; a follow-up its input wakes is a busy period of its own.
        yield* specter.awaitSettled(sessionID)
        const settled = yield* specter.runtime
          .query({ type: "sessionStatus", payload: { sessionID } })
          .pipe(Effect.orDie)
        if (settled.lastOutcome === "failed" && settled.error)
          return yield* new StepFailedError({ error: settled.error })
        // As OC++'s runner's: an interrupted run interrupts its caller.
        if (settled.lastOutcome === "interrupted") return yield* Effect.interrupt
      }),
      interrupt: Effect.fn("SpecterSessionExecution.interrupt")(function* (
        sessionID: SessionSchema.ID,
        options?: { readonly continue?: boolean },
      ) {
        yield* specter.register(sessionID)
        // The running attempt records what it produced before the interruption settles its step.
        yield* specter.stop(sessionID)
        const interrupted = yield* specter.runtime.command({ type: "interruptExecution", payload: { sessionID } }).pipe(
          Effect.as(true),
          // Interrupting an idle Session is a no-op.
          Effect.catch((error) => (rejection(error) === undefined ? Effect.die(error) : Effect.succeed(false))),
        )
        // A user's interrupt also stops the Session's background work, as in OC++'s runner.
        if (interrupted) {
          yield* jobs.cancel(sessionID)
          yield* jobs.cancelAll({ ownerSessionID: sessionID, type: "codemode" })
        }
        if (!options?.continue) return interrupted
        // Continue with steering input and the control items at the queue's head only; queued prompts stay
        // parked until the next idle boundary.
        const next = yield* specter.runtime
          .query({ type: "nextDeliverable", payload: { sessionID, boundary: "entry" } })
          .pipe(Effect.orDie)
        if (next.item !== null)
          yield* specter.runtime.command({ type: "startExecution", payload: { sessionID, continues: true } }).pipe(
            Effect.flatMap((execution) => execution.reactions),
            Effect.catch((error) => (rejection(error) === undefined ? Effect.die(error) : Effect.void)),
          )
        return interrupted
      }),
      awaitIdle: specter.awaitIdle,
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  // External agent Sessions keep their vendor bindings through ExternalAgentSession's projections.
  deps: [SpecterSessionRuntime.node, ExternalAgentSession.node, Job.node],
})
