export * as CodeModeCompletion from "./codemode-completion.js"

import type { FileAttachment } from "@ocpp/schema/prompt"
import { Effect } from "effect"
import type { Job } from "../job.js"
import type { Session } from "../session.js"

export const deliver = Effect.fnUntraced(function* (
  sessions: Pick<Session.Interface, "message" | "synthetic">,
  jobs: Pick<Job.Interface, "completeBackground">,
  input: Pick<Job.Info, "id" | "status" | "notificationID" | "output" | "error"> & {
    recovery: Extract<Job.Recovery, { kind: "codemode" }>
    resume?: boolean
    /** Stable failure category for a failed execution, so consumers never parse the summary text. */
    kind?: string
    /** Media returned by the execution's tool calls, which Code Mode values cannot carry to the model. */
    attachments?: { readonly files: ReadonlyArray<FileAttachment>; readonly note: string }
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
  // A command or event ran this execution outside the model, so its outcome waits in history for the
  // model's next turn instead of waking it.
  const owner = yield* sessions.message({
    sessionID: input.recovery.parentSessionID,
    messageID: input.recovery.assistantMessageID,
  })
  const trigger = owner?.type === "invocation" ? owner.trigger : undefined
  // The job carries the bounded execution summary: saved notebook names, diagnostics, and a small
  // preview. The notebook itself holds the durable output.
  yield* sessions.synthetic({
    ...(input.notificationID ? { id: input.notificationID } : {}),
    sessionID: input.recovery.parentSessionID,
    ...(input.resume === false || input.status === "cancelled" || trigger ? { resume: false } : {}),
    description:
      trigger === undefined
        ? "Execution completed"
        : trigger.type === "command"
          ? "/" + trigger.name
          : "Event " + trigger.name,
    text:
      (trigger === undefined
        ? ""
        : trigger.type === "command"
          ? "The user ran the command /" + trigger.name + " with the text " + JSON.stringify(trigger.text) + ".\n"
          : "The event " + trigger.name + " fired.\n") +
      ((input.status === "completed" ? input.output : input.error) ??
        "Execution " + input.id + " is " + state + " and saved nothing.") +
      (input.attachments ? "\n\n" + input.attachments.note : ""),
    ...(input.attachments?.files.length ? { files: input.attachments.files } : {}),
    metadata: {
      source: "codemode",
      executionID: input.id,
      state,
      ...(state === "completed" || input.kind === undefined ? {} : { kind: input.kind }),
    },
  })
  if (input.notificationID) yield* jobs.completeBackground(input.notificationID)
})
