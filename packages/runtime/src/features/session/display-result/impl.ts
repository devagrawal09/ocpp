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
export type DisplayResultState = {
  sessions: Record<string, "live" | "deleted">
}

export const displayResultStore = Context.Service<SliceStoreService<DisplayResultState, DisplayResultState, unknown>>(
  "@ocpp/runtime/DisplayResultStore",
)

export const createDisplayResultState = (): DisplayResultState => ({ sessions: {} })

const sessionDisplayed = sessionEvent("session-displayed")

const input = Schema.toStandardSchemaV1(SessionEvent.Displayed.data)

export const displayResult = implementCommand(specification)
  .inputSchema(input)
  .store(displayResultStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, applySessionDeleted)
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    return [sessionDisplayed.create(command)]
  })
