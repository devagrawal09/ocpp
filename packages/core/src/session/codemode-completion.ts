export * as CodeModeCompletion from "./codemode-completion.js"

import type { FileAttachment } from "@ocpp/schema/prompt"
import { Effect } from "effect"
import type { Job } from "../job.js"
import type { Session } from "../session.js"
import type { SessionMessage } from "./message.js"

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
  const summary =
    ((input.status === "completed" ? input.output : input.error) ??
      "Execution " + input.id + " is " + state + " and saved nothing.") +
    (input.attachments ? "\n\n" + input.attachments.note : "")
  const metadata = {
    source: "codemode",
    executionID: input.id,
    state,
    ...(state === "completed" || input.kind === undefined ? {} : { kind: input.kind }),
  }
  const failed = state === "completed" ? 0 : 1
  yield* sessions.synthetic({
    ...(input.notificationID ? { id: input.notificationID } : {}),
    sessionID: input.recovery.parentSessionID,
    ...(input.resume === false || input.status === "cancelled" || trigger ? { resume: false } : {}),
    ...(input.attachments?.files.length ? { files: input.attachments.files } : {}),
    ...(trigger === undefined
      ? { description: "Execution completed", text: summary, metadata }
      : {
          ...outcome(trigger, { runs: 1, failed }, summary, metadata),
          // A newer outcome of the same command or event replaces one the model has not seen yet, so a
          // frequent event leaves one pending outcome instead of piling up.
          coalesce: {
            key: "invocation:" + trigger.type + ":" + trigger.name,
            merge: (replaced) =>
              outcome(
                trigger,
                {
                  runs: 1 + replaced.reduce((total, payload) => total + count(payload.metadata?.runs, 1), 0),
                  failed: failed + replaced.reduce((total, payload) => total + count(payload.metadata?.failed, 0), 0),
                },
                summary,
                metadata,
              ),
          },
        }),
  })
  if (input.notificationID) yield* jobs.completeBackground(input.notificationID)
})

/** What the model reads for a command's or event's latest outcome, counting the ones it replaces. */
function outcome(
  trigger: SessionMessage.InvocationTrigger,
  tally: { readonly runs: number; readonly failed: number },
  summary: string,
  metadata: Record<string, unknown>,
) {
  const failures = tally.failed === 0 ? "" : ", and " + tally.failed + " of those runs did not complete"
  const heading =
    trigger.type === "command"
      ? tally.runs === 1
        ? "The user ran the command /" + trigger.name + " with the text " + JSON.stringify(trigger.text) + "."
        : "The user ran the command /" +
          trigger.name +
          " " +
          tally.runs +
          " times since you last saw it" +
          failures +
          ". This is the latest run's outcome; its text was " +
          JSON.stringify(trigger.text) +
          "."
      : tally.runs === 1
        ? "The event " + trigger.name + " fired."
        : "The event " +
          trigger.name +
          " fired " +
          tally.runs +
          " times since you last saw it" +
          failures +
          ". This is the latest firing's outcome."
  return {
    description:
      (trigger.type === "command" ? "/" + trigger.name : "Event " + trigger.name) +
      (tally.runs === 1 ? "" : " (" + tally.runs + (trigger.type === "command" ? " runs)" : " firings)")),
    text: heading + "\n" + summary,
    metadata: { ...metadata, runs: tally.runs, failed: tally.failed },
  }
}

function count(value: unknown, fallback: number) {
  return typeof value === "number" ? value : fallback
}
