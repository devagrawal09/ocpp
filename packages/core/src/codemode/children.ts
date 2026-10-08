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
      return new Map(children).set(
        child,
        entry.status === "completed" ? "completed" : entry.status === "failed" ? "failed" : "interrupted",
      )
    }, new Map<SessionSchema.ID, CodeModeCompletion.ChildStatus>()),
    ([sessionID, status]) => ({ sessionID, status }),
  )
