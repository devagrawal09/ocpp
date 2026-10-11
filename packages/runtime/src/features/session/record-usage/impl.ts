import { SessionEvent } from "@ocpp/schema/session-event"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted. Duplicated in the other Session Slices on purpose.
export type RecordUsageState = {
  sessions: Record<string, "live" | "deleted">
}

export const recordUsageStore = Context.Service<SliceStoreService<RecordUsageState, RecordUsageState, unknown>>(
  "@ocpp/runtime/RecordUsageStore",
)

export const createRecordUsageState = (): RecordUsageState => ({ sessions: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const usageRecorded = sessionEvent("session-usage-recorded")

const input = Schema.toStandardSchemaV1(SessionEvent.UsageRecorded.data)

export const recordUsage = implementCommand(specification)
  .inputSchema(input)
  .store(recordUsageStore)
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
    return [usageRecorded.create(command)]
  })
