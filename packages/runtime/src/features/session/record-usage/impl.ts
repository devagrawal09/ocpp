import { SessionEvent } from "@ocpp/schema/session-event"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applySessionCreated,
  applySessionDeleted,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or deleted.
// Its Session lifecycle is the shared fold in session/lifecycle.ts.
export type RecordUsageState = {
  sessions: Record<string, "live" | "deleted">
}

export const recordUsageStore = Context.Service<SliceStoreService<RecordUsageState, RecordUsageState, unknown>>(
  "@ocpp/runtime/RecordUsageStore",
)

export const createRecordUsageState = (): RecordUsageState => ({ sessions: {} })

const usageRecorded = sessionEvent("session-usage-recorded")

const input = Schema.toStandardSchemaV1(SessionEvent.UsageRecorded.data)

export const recordUsage = implementCommand(specification)
  .inputSchema(input)
  .store(recordUsageStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, applySessionDeleted)
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    return [usageRecorded.create(command)]
  })
