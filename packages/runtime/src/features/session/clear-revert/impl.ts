import { SessionID } from "@ocpp/schema/session-id"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applyExecutionSettled,
  applyExecutionStarted,
  applySessionCreated,
  applySessionDeleted,
  executionSettled,
  executionStarted,
  forgetSession,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or deleted,
// the Sessions with an active execution, and those with a staged revert. Its
// Session lifecycle is the shared fold in session/lifecycle.ts; the rest is
// duplicated from the other revert Slices on purpose.
export type ClearRevertState = {
  sessions: Record<string, "live" | "deleted">
  active: Record<string, true>
  staged: Record<string, true>
}

export const clearRevertStore = Context.Service<SliceStoreService<ClearRevertState, ClearRevertState, unknown>>(
  "@ocpp/runtime/ClearRevertStore",
)

export const createClearRevertState = (): ClearRevertState => ({ sessions: {}, active: {}, staged: {} })

const revertStaged = sessionEvent("session-revert-staged")
const revertCleared = sessionEvent("session-revert-cleared")
const revertCommitted = sessionEvent("session-revert-committed")

const input = Schema.toStandardSchemaV1(Schema.Struct({ sessionID: SessionID }))

export const clearRevert = implementCommand(specification)
  .inputSchema(input)
  .store(clearRevertStore, { stateVersion: 2 })
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  // A deleted Session is forgotten but for its tombstone.
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
    forgetSession(event.payload.sessionID, state.active, state.staged)
  })
  .apply(executionStarted, applyExecutionStarted)
  .apply(executionSettled, applyExecutionSettled)
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
    requireLiveSession(state, command.sessionID)
    if (state.active[command.sessionID]) throw new CommandRejection("session-busy", "Session is busy")
    if (!state.staged[command.sessionID]) throw new CommandRejection("no-revert-staged", "No revert staged")
    return [revertCleared.create({ sessionID: command.sessionID })]
  })
