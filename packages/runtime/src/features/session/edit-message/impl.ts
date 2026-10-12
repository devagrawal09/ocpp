import { SessionEvent } from "@ocpp/schema/session-event"
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
// and the Sessions with an active execution. Its Session lifecycle is the
// shared fold in session/lifecycle.ts; the rest is duplicated from the other
// Session Slices on purpose.
export type EditMessageState = {
  sessions: Record<string, "live" | "deleted">
  active: Record<string, true>
}

export const editMessageStore = Context.Service<SliceStoreService<EditMessageState, EditMessageState, unknown>>(
  "@ocpp/runtime/EditMessageStore",
)

export const createEditMessageState = (): EditMessageState => ({ sessions: {}, active: {} })

const contentUpdated = sessionEvent("session-message-content-updated")

const input = Schema.toStandardSchemaV1(SessionEvent.MessageContentUpdated.data)

export const editMessage = implementCommand(specification)
  .inputSchema(input)
  .store(editMessageStore, { stateVersion: 2 })
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  // A deleted Session is forgotten but for its tombstone.
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
    forgetSession(event.payload.sessionID, state.active)
  })
  .apply(executionStarted, applyExecutionStarted)
  .apply(executionSettled, applyExecutionSettled)
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    if (state.active[command.sessionID]) throw new CommandRejection("session-busy", "Session is busy")
    return [contentUpdated.create(command)]
  })
