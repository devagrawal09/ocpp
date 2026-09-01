export * as CodeModeCompletion from "./codemode-completion.js"

import { Effect } from "effect"
import type { Job } from "../job.js"
import type { Session } from "../session.js"

export const deliver = Effect.fnUntraced(function* (
  sessions: Pick<Session.Interface, "message" | "synthetic">,
  jobs: Pick<Job.Interface, "completeBackground">,
  input: Pick<Job.Info, "id" | "status" | "notificationID"> & {
    recovery: Extract<Job.Recovery, { kind: "codemode" }>
    resume?: boolean
  },
) {
  if (input.status === "running") return
  if (
    input.notificationID &&
    (yield* sessions.message({ sessionID: input.recovery.parentSessionID, messageID: input.notificationID }))
  ) {
    yield* jobs.completeBackground(input.notificationID)
    return
  }
  const state = input.status === "completed" ? "completed" : input.status === "cancelled" ? "cancelled" : "failed"
  yield* sessions.synthetic({
    ...(input.notificationID ? { id: input.notificationID } : {}),
    sessionID: input.recovery.parentSessionID,
    ...(input.resume === false || input.status === "cancelled" ? { resume: false } : {}),
    description: "Execution completed",
    text:
      "Execution " +
      input.id +
      " is " +
      state +
      ". Use execution_result with this execution ID to retrieve the durable result.",
    metadata: { source: "codemode", executionID: input.id, state },
  })
  if (input.notificationID) yield* jobs.completeBackground(input.notificationID)
})
