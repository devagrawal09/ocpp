import { SessionEvent } from "@ocpp/schema/session-event"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted, and the Sessions with an active execution. Duplicated from the
// other Session Slices on purpose.
export type EditMessageState = {
  sessions: Record<string, "live" | "deleted">
  active: Record<string, true>
}

export const editMessageStore = Context.Service<SliceStoreService<EditMessageState, EditMessageState, unknown>>(
  "@ocpp/runtime/EditMessageStore",
)

export const createEditMessageState = (): EditMessageState => ({ sessions: {}, active: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const executionStarted = sessionEvent("session-execution-started")
const executionSettled = sessionEvent("session-execution-settled")
const contentUpdated = sessionEvent("session-message-content-updated")

const input = Schema.toStandardSchemaV1(SessionEvent.MessageContentUpdated.data)

export const editMessage = implementCommand(specification)
  .inputSchema(input)
  .store(editMessageStore)
  .consistencyKeys({ session: (command) => command.sessionID })
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
  .handle(async (command, state) => {
    if (!state.sessions[command.sessionID]) throw new Error("Session not found")
    if (state.sessions[command.sessionID] === "deleted") throw new Error("Session deleted")
    if (state.active[command.sessionID]) throw new Error("Session is busy")
    return [contentUpdated.create(command)]
  })
