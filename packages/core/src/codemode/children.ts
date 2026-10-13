export * as CodeModeChildren from "./children.js"

import { Schema } from "effect"
import type { CodeModeCompletion } from "../session/codemode-completion.js"
import { SessionSchema } from "../session/schema.js"

const isSessionID = Schema.is(SessionSchema.ID)

/**
 * The child session a tool call names through a `sessionID` in its metadata, progress, or output.
 * Any well-formed `sessionID` counts, whatever status the record carries alongside it, so a call
 * that only reported starting its child still names it.
 */
export const sessionID = (source: unknown): SessionSchema.ID | undefined => {
  if (typeof source !== "object" || source === null || !("sessionID" in source)) return undefined
  const sessionID = source.sessionID
  return isSessionID(sessionID) ? sessionID : undefined
}

/**
 * Whether a call's outcome is a follow-up steered into a child that an earlier call is still running:
 * the call sent the child a message but did not run it, so its result arrives with that earlier call.
 */
export const delivered = (source: unknown) =>
  typeof source === "object" && source !== null && "status" in source && source.status === "delivered"

/**
 * The status to keep for a child named again in the same execution. A delivered follow-up never replaces
 * what a call that ran the child recorded; anything else replaces what came before.
 */
export const merge = (
  previous: CodeModeCompletion.ChildStatus | undefined,
  next: CodeModeCompletion.ChildStatus,
): CodeModeCompletion.ChildStatus =>
  next === "delivered" && previous !== undefined && previous !== "delivered" ? previous : next

/**
 * The child sessions an execution's journaled calls named, as the live collector would have listed
 * them: a settled call keeps its outcome, and a call that never settled was interrupted.
 */
export const fromJournal = (
  entries: ReadonlyArray<{
    readonly status: "scheduled" | "completed" | "failed" | "indeterminate"
    readonly output: unknown
    readonly progress: unknown
  }>,
): ReadonlyArray<CodeModeCompletion.Child> =>
  Array.from(
    entries.reduce((children, entry) => {
      const child = sessionID(entry.progress) ?? sessionID(entry.output)
      if (child === undefined) return children
      const status =
        entry.status === "completed"
          ? delivered(entry.output)
            ? "delivered"
            : "completed"
          : entry.status === "failed"
            ? "failed"
            : "interrupted"
      return new Map(children).set(child, merge(children.get(child), status))
    }, new Map<SessionSchema.ID, CodeModeCompletion.ChildStatus>()),
    ([sessionID, status]) => ({ sessionID, status }),
  )
