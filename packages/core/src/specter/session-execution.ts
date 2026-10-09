export * as SpecterSessionExecution from "./session-execution.js"

import { Effect, Layer } from "effect"
import { SessionDriver } from "@ocpp/schema/session-driver"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { ExternalAgentSession } from "../external-agent/session.js"
import { Job } from "../job.js"
import { LocationServiceMap } from "../location-service-map.js"
import { StepFailedError } from "../session/error.js"
import { SessionExecution } from "../session/execution.js"
import { SessionSchema } from "../session/schema.js"
import { SessionStore } from "../session/store.js"
import { rejection, SpecterSessionRuntime } from "./session-runtime.js"

/**
 * `SessionExecution.Service` when the embedded Specter runtime runs Sessions. A recorded input wakes
 * the runtime through its own Reaction unless it was admitted held (`resume: false`); `wake` starts an
 * execution for held input too. A Session whose model selects an external agent is that agent's to
 * run: its executions go through OC++'s external agent harness, as before.
 */
export const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const specter = yield* SpecterSessionRuntime.Service
    const external = yield* SessionExecution.make()
    const store = yield* SessionStore.Service
    const jobs = yield* Job.Service

    // Read at each call: a Session can change models, and with them its driver, between executions.
    const driven = (sessionID: SessionSchema.ID) =>
      store
        .get(sessionID)
        .pipe(Effect.map((session) => session !== undefined && SessionDriver.of(session.model) !== "ocpp"))

    // Starts an execution unless one is active. A rejection means it is already running.
    const start = (sessionID: SessionSchema.ID) =>
      specter.runtime.command({ type: "startExecution", payload: { sessionID } }).pipe(
        Effect.flatMap((execution) => execution.reactions),
        Effect.catch((error) => (rejection(error) === undefined ? Effect.die(error) : Effect.void)),
      )

    const runtime = SessionExecution.Service.of({
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
        yield* specter.awaitIdle(sessionID)
        const settled = yield* specter.runtime
          .query({ type: "executionStatus", payload: { sessionID } })
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
        // Continue with steering input only; queued prompts stay parked until the next idle boundary.
        const next = yield* specter.runtime
          .query({ type: "nextDeliverable", payload: { sessionID, boundary: "step" } })
          .pipe(Effect.orDie)
        if (next.item !== null) yield* start(sessionID)
        return interrupted
      }),
      awaitIdle: specter.awaitIdle,
    })

    // Each call goes to whichever runs the Session now.
    const route =
      <Args extends ReadonlyArray<unknown>, A, E>(
        select: (
          service: SessionExecution.Interface,
        ) => (sessionID: SessionSchema.ID, ...args: Args) => Effect.Effect<A, E>,
      ) =>
      (sessionID: SessionSchema.ID, ...args: Args) =>
        driven(sessionID).pipe(Effect.flatMap((isDriven) => select(isDriven ? external : runtime)(sessionID, ...args)))

    return SessionExecution.Service.of({
      active: Effect.all([runtime.active, external.active]).pipe(
        Effect.map(([own, theirs]) => new Set([...own, ...theirs])),
      ),
      isActive: (sessionID) =>
        Effect.all([runtime.isActive(sessionID), external.isActive(sessionID)]).pipe(
          Effect.map(([own, theirs]) => own || theirs),
        ),
      wake: route((service) => service.wake),
      resume: route((service) => service.resume),
      interrupt: route((service) => service.interrupt),
      awaitIdle: route((service) => service.awaitIdle),
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  // The external agent execution's own dependencies, beside the runtime's.
  deps: [
    SpecterSessionRuntime.node,
    ExternalAgentSession.node,
    SessionStore.node,
    LocationServiceMap.node,
    Bus.node,
    Database.node,
    Job.node,
  ],
})
