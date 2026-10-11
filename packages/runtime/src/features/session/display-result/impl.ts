import { SessionEvent } from "@ocpp/schema/session-event"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted. Duplicated in the other Session Slices on purpose.
export type DisplayResultState = {
  sessions: Record<string, "live" | "deleted">
}

export const displayResultStore = Context.Service<SliceStoreService<DisplayResultState, DisplayResultState, unknown>>(
  "@ocpp/runtime/DisplayResultStore",
)

export const createDisplayResultState = (): DisplayResultState => ({ sessions: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const sessionDisplayed = sessionEvent("session-displayed")

const input = Schema.toStandardSchemaV1(SessionEvent.Displayed.data)

export const displayResult = implementCommand(specification)
  .inputSchema(input)
  .store(displayResultStore)
  .consistencyKeys((command) => [command.sessionID])
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
  })
  .handle(async (command, state) => {
    if (!state.sessions[command.sessionID]) throw new Error("Session not found")
    if (state.sessions[command.sessionID] === "deleted") throw new Error("Session deleted")
    return [sessionDisplayed.create(command)]
  })
