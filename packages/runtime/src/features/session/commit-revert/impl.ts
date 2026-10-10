import { SessionID } from "@ocpp/schema/session-id"
import type { SessionMessage } from "@ocpp/schema/session-message"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted, the Sessions with an active execution, the message each staged
// revert cuts at, and each Session's pending inbox items in admission order.
// Duplicated from the other revert and inbox Slices on purpose.
export type CommitRevertState = {
  sessions: Record<string, "live" | "deleted">
  active: Record<string, true>
  staged: Record<string, SessionMessage.ID>
  pending: Record<string, SessionMessage.ID[]>
}

export const commitRevertStore = Context.Service<SliceStoreService<CommitRevertState, CommitRevertState, unknown>>(
  "@ocpp/runtime/CommitRevertStore",
)

export const createCommitRevertState = (): CommitRevertState => ({ sessions: {}, active: {}, staged: {}, pending: {} })

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

const input = Schema.toStandardSchemaV1(Schema.Struct({ sessionID: SessionID }))

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
  })
  .apply(revertCleared, async (event, state) => {
    delete state.staged[event.payload.sessionID]
  })
  .apply(revertCommitted, async (event, state) => {
    delete state.staged[event.payload.sessionID]
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
    return [
      ...(state.pending[sessionID] ?? []).map((inboxID) => inboxCancelled.create({ sessionID, inboxID })),
      revertCommitted.create({ sessionID, to }),
    ]
  })
