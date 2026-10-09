import { Bus } from "@ocpp/core/bus"
import { Job } from "@ocpp/core/job"
import { UserInterruptedError } from "@ocpp/core/session/error"
import { SessionEvent } from "@ocpp/core/session/event"
import { SessionExecution } from "@ocpp/core/session/execution"
import type { SessionInbox } from "@ocpp/core/session/inbox"
import type { SessionRunner } from "@ocpp/core/session/runner/index"
import type { SessionSchema } from "@ocpp/core/session/schema"
import { toSessionError } from "@ocpp/core/session/to-session-error"
import { Cause, Effect, Exit } from "effect"
import { SessionRunCoordinator } from "./run-coordinator"

/**
 * A SessionExecution that runs each Session with a scripted drain in this process, without the Specter
 * runtime: OC++'s former coordinator semantics (coalesced wakes, joining resumes) and execution lifecycle
 * events. Restart recovery tests use it to observe which Sessions recovery wakes.
 */
export const makeLocalExecution = (
  drain: (input: {
    readonly sessionID: SessionSchema.ID
    readonly force: boolean
    readonly promotable: SessionInbox.Promotable
  }) => Effect.Effect<void, SessionRunner.RunError>,
) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const jobs = yield* Job.Service
    const coordinator = yield* SessionRunCoordinator.make<
      SessionSchema.ID,
      SessionRunner.RunError,
      "user" | "shutdown"
    >({
      started: (sessionID) => bus.publish(SessionEvent.Execution.Started, { sessionID }).pipe(Effect.asVoid),
      drain: (sessionID, force, promotable) => drain({ sessionID, force, promotable }),
      settled: (sessionID, exit, reason) =>
        Effect.gen(function* () {
          if (Exit.isSuccess(exit)) {
            yield* bus.publish(SessionEvent.Execution.Succeeded, { sessionID })
            return
          }
          const failure = Cause.hasInterrupts(exit.cause) ? undefined : Cause.squash(exit.cause)
          if (failure === undefined || failure instanceof UserInterruptedError) {
            const interrupted = failure === undefined ? (reason ?? "shutdown") : "user"
            if (interrupted === "user") {
              yield* jobs.cancel(sessionID)
              yield* jobs.cancelAll({ ownerSessionID: sessionID, type: "codemode" })
            }
            yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: interrupted })
            return
          }
          yield* bus.publish(SessionEvent.Execution.Failed, { sessionID, error: toSessionError(failure) })
        }),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      isActive: coordinator.isActive,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: (sessionID) => coordinator.interrupt(sessionID, "user"),
      awaitIdle: coordinator.awaitIdle,
    })
  })
