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
export type SelectToolsState = {
  sessions: Record<string, "live" | "deleted">
}

export const selectToolsStore = Context.Service<SliceStoreService<SelectToolsState, SelectToolsState, unknown>>(
  "@ocpp/runtime/SelectToolsStore",
)

export const createSelectToolsState = (): SelectToolsState => ({ sessions: {} })

const toolsSelected = sessionEvent("session-tools-selected")

const input = Schema.toStandardSchemaV1(SessionEvent.ToolsSelected.data)

export const selectTools = implementCommand(specification)
  .inputSchema(input)
  .store(selectToolsStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, applySessionDeleted)
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    return [toolsSelected.create(command)]
  })
