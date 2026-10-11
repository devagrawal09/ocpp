import { optional } from "@ocpp/schema/schema"
import { SessionID } from "@ocpp/schema/session-id"
import type { SessionMessage } from "@ocpp/schema/session-message"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted, the Sessions with an active execution, the message each staged
// revert cuts at, each Session's pending inbox items in admission order, each
// Session's Code Mode executions that have not settled, and those admitted
// since its revert was staged. Duplicated from the other revert, inbox and
// Code Mode Slices on purpose.
export type CommitRevertState = {
  sessions: Record<string, "live" | "deleted">
  active: Record<string, true>
  staged: Record<string, SessionMessage.ID>
  pending: Record<string, SessionMessage.ID[]>
  running: Record<string, Record<string, true>>
  sinceStaged: Record<string, string[]>
}

export const commitRevertStore = Context.Service<SliceStoreService<CommitRevertState, CommitRevertState, unknown>>(
  "@ocpp/runtime/CommitRevertStore",
)

export const createCommitRevertState = (): CommitRevertState => ({
  sessions: {},
  active: {},
  staged: {},
  pending: {},
  running: {},
  sinceStaged: {},
})

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const executionStarted = sessionEvent("session-execution-started")
const executionSettled = sessionEvent("session-execution-settled")
const revertStaged = sessionEvent("session-revert-staged")
const revertCleared = sessionEvent("session-revert-cleared")
const revertCommitted = sessionEvent("session-revert-committed")
const inboxEnqueued = sessionEvent("session-inbox-enqueued")
const inboxDelivered = sessionEvent("session-inbox-delivered")
const inboxCancelled = sessionEvent("session-inbox-cancelled")
const codeModeAdmitted = sessionEvent("session-codemode-execution-admitted")
const codeModeSettled = sessionEvent("session-codemode-execution-settled")
const codeModeDiscarded = sessionEvent("session-codemode-execution-discarded")
const notebookReverted = sessionEvent("session-codemode-notebook-reverted")

const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    sessionID: SessionID,
    // The Code Mode executions the cut leaves without their message, as the host resolves them from where each
    // message sits: those still running, and those whose saved values the Session's notebook holds.
    executions: optional(Schema.Array(Schema.String)),
  }),
)

const REVERTED = "The message that started this execution was reverted; nothing was saved."

const settle = (state: CommitRevertState, payload: { readonly sessionID: string; readonly inboxID: string }) => {
  const pending = state.pending[payload.sessionID]
  if (pending) state.pending[payload.sessionID] = pending.filter((inboxID) => inboxID !== payload.inboxID)
}

export const commitRevert = implementCommand(specification)
  .inputSchema(input)
  .store(commitRevertStore)
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
  })
  .apply(executionStarted, async (event, state) => {
    state.active[event.payload.sessionID] = true
  })
  .apply(executionSettled, async (event, state) => {
    delete state.active[event.payload.sessionID]
  })
  .apply(revertStaged, async (event, state) => {
    state.staged[event.payload.sessionID] = event.payload.revert.messageID
    state.sinceStaged[event.payload.sessionID] = []
  })
  .apply(revertCleared, async (event, state) => {
    delete state.staged[event.payload.sessionID]
    delete state.sinceStaged[event.payload.sessionID]
  })
  .apply(revertCommitted, async (event, state) => {
    delete state.staged[event.payload.sessionID]
    delete state.sinceStaged[event.payload.sessionID]
  })
  .apply(codeModeAdmitted, async (event, state) => {
    const { sessionID, executionID } = event.payload
    ;(state.running[sessionID] ??= {})[executionID] = true
    state.sinceStaged[sessionID]?.push(executionID)
  })
  .apply(codeModeSettled, async (event, state) => {
    delete state.running[event.payload.sessionID]?.[event.payload.executionID]
  })
  .apply(codeModeDiscarded, async (event, state) => {
    delete state.running[event.payload.sessionID]?.[event.payload.executionID]
  })
  .apply(inboxEnqueued, async (event, state) => {
    const { sessionID, inboxID } = event.payload
    state.pending[sessionID] = [...(state.pending[sessionID] ?? []), inboxID]
  })
  .apply(inboxDelivered, async (event, state) => {
    settle(state, event.payload)
  })
  .apply(inboxCancelled, async (event, state) => {
    settle(state, event.payload)
  })
  .handle(async (command, state) => {
    const { sessionID } = command
    if (!state.sessions[sessionID]) throw new Error("Session not found")
    if (state.sessions[sessionID] === "deleted") throw new Error("Session deleted")
    if (state.active[sessionID]) throw new Error("Session is busy")
    const to = state.staged[sessionID]
    if (to === undefined) throw new Error("No revert staged")
    // An execution admitted since the revert was staged started after the message it cuts at.
    const cut = [...new Set([...(command.executions ?? []), ...(state.sinceStaged[sessionID] ?? [])])]
    return [
      ...cut
        .filter((executionID) => state.running[sessionID]?.[executionID])
        .map((executionID) => codeModeSettled.create({ sessionID, executionID, outcome: "failed", error: REVERTED })),
      ...(cut.length === 0 ? [] : [notebookReverted.create({ sessionID, executions: cut })]),
      ...(state.pending[sessionID] ?? []).map((inboxID) => inboxCancelled.create({ sessionID, inboxID })),
      revertCommitted.create({ sessionID, to }),
    ]
  })
