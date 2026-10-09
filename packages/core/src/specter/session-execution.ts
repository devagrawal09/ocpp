export * as SpecterSessionExecution from "./session-execution.js"

import { Effect, Layer } from "effect"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { SessionExecution } from "../session/execution.js"
import { SessionSchema } from "../session/schema.js"
import { rejection, SpecterSessionRuntime } from "./session-runtime.js"

/**
 * `SessionExecution.Service` when the embedded Specter runtime runs Sessions. The runtime decides when
 * to execute: a recorded input wakes it through its own Reaction, so `wake` has nothing to do. The
 * runtime runs every Session, whatever its driver; external agent harnesses are not routed here yet.
 */
export const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const specter = yield* SpecterSessionRuntime.Service
    const isActive = (sessionID: SessionSchema.ID) => specter.active.pipe(Effect.map((active) => active.has(sessionID)))

    // Starts an execution unless one is active. A rejection means it is already running.
    const start = (sessionID: SessionSchema.ID) =>
      specter.runtime.command({ type: "startExecution", payload: { sessionID } }).pipe(
        Effect.flatMap((execution) => execution.reactions),
        Effect.catch((error) => (rejection(error) === undefined ? Effect.die(error) : Effect.void)),
      )

    return SessionExecution.Service.of({
      active: specter.active,
      isActive,
      wake: () => Effect.void,
      resume: Effect.fn("SpecterSessionExecution.resume")(function* (sessionID: SessionSchema.ID) {
        yield* specter.register(sessionID)
        yield* start(sessionID)
        yield* specter.awaitIdle(sessionID)
      }),
      interrupt: Effect.fn("SpecterSessionExecution.interrupt")(function* (
        sessionID: SessionSchema.ID,
        options?: { readonly continue?: boolean },
      ) {
        yield* specter.register(sessionID)
        const interrupted = yield* specter.runtime.command({ type: "interruptExecution", payload: { sessionID } }).pipe(
          Effect.as(true),
          // Interrupting an idle Session is a no-op.
          Effect.catch((error) => (rejection(error) === undefined ? Effect.die(error) : Effect.succeed(false))),
        )
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
  }),
)

export const node = makeGlobalNode({ service: SessionExecution.Service, layer, deps: [SpecterSessionRuntime.node] })
