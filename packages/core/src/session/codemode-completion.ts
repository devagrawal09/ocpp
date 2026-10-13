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
    /** Child sessions the execution's tool calls started or continued, listed whether or not the program kept their IDs. */
    children?: ReadonlyArray<Child>
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
    withChildren(
      (input.status === "completed" ? input.output : input.error) ??
        "Execution " + input.id + " is " + state + " and saved nothing.",
      input.children,
    ) + (input.attachments ? "\n\n" + input.attachments.note : "")
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

/** A subagent an execution started, as a start notice names it. */
export type Started = { readonly executionID: string; readonly sessionID: string }

/**
 * Tells the parent model, while the execution still runs, that one of its tool calls started a subagent,
 * so it can read the child's transcript before the completion lists it. The notice is an ordinary steer:
 * a running turn reads it at its next step, and an idle parent is woken to read it. Notices the model has
 * not read yet merge into one, so children that start close together cost one turn. It names only
 * execution and child IDs, never text the child controls. An execution a command or event ran outside
 * the model announces nothing, as its outcome waits for the model's next turn.
 */
export const started = Effect.fnUntraced(function* (
  sessions: Pick<Session.Interface, "message" | "synthetic">,
  input: Started & {
    readonly recovery: Pick<Extract<Job.Recovery, { kind: "codemode" }>, "parentSessionID" | "assistantMessageID">
  },
) {
  const child = { executionID: input.executionID, sessionID: input.sessionID }
  if (!wellFormed(child)) return
  const owner = yield* sessions.message({
    sessionID: input.recovery.parentSessionID,
    messageID: input.recovery.assistantMessageID,
  })
  if (owner?.type === "invocation") return
  yield* sessions.synthetic({
    sessionID: input.recovery.parentSessionID,
    ...startedNotice([child]),
    coalesce: {
      key: "codemode:subagents-started",
      merge: (replaced) => startedNotice([...replaced.flatMap((payload) => startedChildren(payload.metadata)), child]),
    },
  })
})

const wellFormed = (child: Started) => EXECUTION_ID.test(child.executionID) && CHILD_SESSION_ID.test(child.sessionID)

/** The children an earlier start notice named, from its metadata. */
const startedChildren = (metadata: Record<string, unknown> | undefined): ReadonlyArray<Started> => {
  const listed = metadata?.subagentsStarted
  if (!Array.isArray(listed)) return []
  return listed.flatMap((entry) =>
    typeof entry === "object" &&
    entry !== null &&
    typeof entry.execution === "string" &&
    typeof entry.sessionID === "string" &&
    wellFormed({ executionID: entry.execution, sessionID: entry.sessionID })
      ? [{ executionID: entry.execution, sessionID: entry.sessionID }]
      : [],
  )
}

/** What the model reads for the subagents that started since it last looked, oldest first. */
export const startedNotice = (children: ReadonlyArray<Started>) => {
  const unique = Array.from(
    new Map(children.map((child) => [child.executionID + "/" + child.sessionID, child] as const)).values(),
  )
  const first = unique[0]
  const text =
    unique.length === 1 && first
      ? "Execution " +
        first.executionID +
        " started subagent session " +
        first.sessionID +
        ". Read its progress with tools.subagent.transcript({ sessionID: " +
        JSON.stringify(first.sessionID) +
        " }); its result arrives with the execution's completion."
      : "Subagent sessions started: " +
        unique
          .slice(0, MAX_LISTED_CHILDREN)
          .map((child) => child.sessionID + " (execution " + child.executionID + ")")
          .join(", ") +
        (unique.length > MAX_LISTED_CHILDREN ? ", and " + (unique.length - MAX_LISTED_CHILDREN) + " more" : "") +
        ". Read one's progress with tools.subagent.transcript({ sessionID }); each result arrives with its execution's completion."
  return {
    description: unique.length === 1 ? "Subagent started" : "Subagents started",
    text,
    // No `executionID` key: consumers read that as the execution's completion notification.
    metadata: {
      source: "codemode",
      subagentsStarted: unique.map((child) => ({ execution: child.executionID, sessionID: child.sessionID })),
    },
  }
}

/**
 * Where a child session's work stood when the execution that called it ended. "delivered" means the
 * execution only steered a follow-up into a run an earlier call owns, whose result arrives with that call.
 */
export type ChildStatus = "running" | "completed" | "failed" | "interrupted" | "delivered"

export type Child = { readonly sessionID: string; readonly status: ChildStatus }

const MAX_LISTED_CHILDREN = 20
// Session IDs are harness-generated, so a well-formed one is safe on a harness-trusted line. Anything
// else a tool put in its metadata is dropped instead of reaching the model outside an untrusted block.
const CHILD_SESSION_ID = /^ses[A-Za-z0-9_-]{1,96}$/
const EXECUTION_ID = /^exe[A-Za-z0-9_-]{1,96}$/

/**
 * Adds one harness-written line naming the execution's child sessions right after the summary's
 * header line, so it survives the summary's truncation from the end. It carries only IDs and
 * statuses, never titles or other text a child controls.
 */
function withChildren(summary: string, children: ReadonlyArray<Child> | undefined) {
  const valid = (children ?? []).filter((child) => CHILD_SESSION_ID.test(child.sessionID))
  if (valid.length === 0) return summary
  const listed = valid
    .slice(0, MAX_LISTED_CHILDREN)
    .map((child) => child.sessionID + " (" + child.status + ")")
    .join(", ")
  const more = valid.length > MAX_LISTED_CHILDREN ? ", and " + (valid.length - MAX_LISTED_CHILDREN) + " more" : ""
  const line =
    "Subagent sessions: " +
    listed +
    more +
    ". Pass a sessionID to tools.subagent to continue one, or to tools.subagent.transcript to read it."
  const header = summary.indexOf("\n")
  return header === -1 ? summary + "\n" + line : summary.slice(0, header) + "\n" + line + summary.slice(header)
}

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
