import { SessionEvent } from "@ocpp/schema/session-event"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted. Duplicated in the other Session Slices on purpose.
export type AppendSyntheticState = {
  sessions: Record<string, "live" | "deleted">
}

export const appendSyntheticStore = Context.Service<
  SliceStoreService<AppendSyntheticState, AppendSyntheticState, unknown>
>("@ocpp/runtime/AppendSyntheticStore")

export const createAppendSyntheticState = (): AppendSyntheticState => ({ sessions: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const syntheticAppended = sessionEvent("session-synthetic")

const input = Schema.toStandardSchemaV1(SessionEvent.Synthetic.data)

export const appendSynthetic = implementCommand(specification)
  .inputSchema(input)
  .store(appendSyntheticStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
  })
  .handle(async (command, state) => {
    if (!state.sessions[command.sessionID]) throw new Error("Session not found")
    if (state.sessions[command.sessionID] === "deleted") throw new Error("Session deleted")
    return [syntheticAppended.create(command)]
  })
