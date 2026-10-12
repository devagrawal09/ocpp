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
export type ViewSessionState = {
  sessions: Record<string, "live" | "deleted">
}

export const viewSessionStore = Context.Service<SliceStoreService<ViewSessionState, ViewSessionState, unknown>>(
  "@ocpp/runtime/ViewSessionStore",
)

export const createViewSessionState = (): ViewSessionState => ({ sessions: {} })

const sessionViewed = sessionEvent("session-viewed")

const input = Schema.toStandardSchemaV1(SessionEvent.Viewed.data)

export const viewSession = implementCommand(specification)
  .inputSchema(input)
  .store(viewSessionStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, applySessionDeleted)
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    return [sessionViewed.create(command)]
  })
