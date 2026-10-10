import { SessionEvent } from "@ocpp/schema/session-event"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted. Duplicated in the other Session Slices on purpose.
export type ViewSessionState = {
  sessions: Record<string, "live" | "deleted">
}

export const viewSessionStore = Context.Service<SliceStoreService<ViewSessionState, ViewSessionState, unknown>>(
  "@ocpp/runtime/ViewSessionStore",
)

export const createViewSessionState = (): ViewSessionState => ({ sessions: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const sessionViewed = sessionEvent("session-viewed")

const input = Schema.toStandardSchemaV1(SessionEvent.Viewed.data)

export const viewSession = implementCommand(specification)
  .inputSchema(input)
  .store(viewSessionStore)
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
  })
  .handle(async (command, state) => {
    if (!state.sessions[command.sessionID]) throw new Error("Session not found")
    if (state.sessions[command.sessionID] === "deleted") throw new Error("Session deleted")
    return [sessionViewed.create(command)]
  })
