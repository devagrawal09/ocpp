export * as CodeModeCompletion from "./codemode-completion.js"

import { Effect } from "effect"
import type { Job } from "../job.js"
import type { Session } from "../session.js"

export const deliver = Effect.fnUntraced(function* (
  sessions: Pick<Session.Interface, "message" | "synthetic">,
  jobs: Pick<Job.Interface, "completeBackground">,
  input: Pick<Job.Info, "id" | "status" | "output" | "error" | "notificationID"> & {
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
  const text =
    input.status === "completed"
      ? (input.output ?? "Execution completed without a result.")
      : input.status === "error"
        ? (input.error ?? "Execution failed")
        : "Execution cancelled"
  yield* sessions.synthetic({
    ...(input.notificationID ? { id: input.notificationID } : {}),
    sessionID: input.recovery.parentSessionID,
    ...(input.resume === false || input.status === "cancelled" ? { resume: false } : {}),
    description: "Code Mode execution",
    text: `<codemode executionID="${input.id}" state="${input.status}">\n${text}\n</codemode>`,
    metadata: { source: "codemode", executionID: input.id, state: input.status },
  })
  if (input.notificationID) yield* jobs.completeBackground(input.notificationID)
})
