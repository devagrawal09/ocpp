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
export type AppendSyntheticState = {
  sessions: Record<string, "live" | "deleted">
}

export const appendSyntheticStore = Context.Service<
  SliceStoreService<AppendSyntheticState, AppendSyntheticState, unknown>
>("@ocpp/runtime/AppendSyntheticStore")

export const createAppendSyntheticState = (): AppendSyntheticState => ({ sessions: {} })

const syntheticAppended = sessionEvent("session-synthetic")

const input = Schema.toStandardSchemaV1(SessionEvent.Synthetic.data)

export const appendSynthetic = implementCommand(specification)
  .inputSchema(input)
  .store(appendSyntheticStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, applySessionDeleted)
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    return [syntheticAppended.create(command)]
  })
