import { SessionID } from "@ocpp/schema/session-id"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted, the Sessions with an active execution, and those with a staged
// revert. Duplicated from the other revert Slices on purpose.
export type ClearRevertState = {
  sessions: Record<string, "live" | "deleted">
  active: Record<string, true>
  staged: Record<string, true>
}

export const clearRevertStore = Context.Service<SliceStoreService<ClearRevertState, ClearRevertState, unknown>>(
  "@ocpp/runtime/ClearRevertStore",
)

export const createClearRevertState = (): ClearRevertState => ({ sessions: {}, active: {}, staged: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const executionStarted = sessionEvent("session-execution-started")
const executionSettled = sessionEvent("session-execution-settled")
const revertStaged = sessionEvent("session-revert-staged")
const revertCleared = sessionEvent("session-revert-cleared")
const revertCommitted = sessionEvent("session-revert-committed")

const input = Schema.toStandardSchemaV1(Schema.Struct({ sessionID: SessionID }))

export const clearRevert = implementCommand(specification)
  .inputSchema(input)
  .store(clearRevertStore)
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
    state.staged[event.payload.sessionID] = true
  })
  .apply(revertCleared, async (event, state) => {
    delete state.staged[event.payload.sessionID]
  })
  .apply(revertCommitted, async (event, state) => {
    delete state.staged[event.payload.sessionID]
  })
  .handle(async (command, state) => {
    if (!state.sessions[command.sessionID]) throw new Error("Session not found")
    if (state.sessions[command.sessionID] === "deleted") throw new Error("Session deleted")
    if (state.active[command.sessionID]) throw new Error("Session is busy")
    if (!state.staged[command.sessionID]) throw new Error("No revert staged")
    return [revertCleared.create({ sessionID: command.sessionID })]
  })
