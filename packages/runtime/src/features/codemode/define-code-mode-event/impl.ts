import { SessionFact } from "@ocpp/schema/session-fact"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applySessionCreated,
  applySessionDeleted,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
} from "../../session/lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or deleted.
// Defining a event that exists replaces it, so this Slice needs no more. Its
// Session lifecycle is the shared fold in session/lifecycle.ts; the rest is
// duplicated from the other Code Mode event Slices on purpose.
export type DefineCodeModeEventState = {
  sessions: Record<string, "live" | "deleted">
}

export const defineCodeModeEventStore = Context.Service<
  SliceStoreService<DefineCodeModeEventState, DefineCodeModeEventState, unknown>
>("@ocpp/runtime/DefineCodeModeEventStore")

export const createDefineCodeModeEventState = (): DefineCodeModeEventState => ({ sessions: {} })

const defined = sessionEvent("session-codemode-event-defined")

const input = Schema.toStandardSchemaV1(SessionFact.EventDefined.data)

export const defineCodeModeEvent = implementCommand(specification)
  .inputSchema(input)
  .store(defineCodeModeEventStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, applySessionDeleted)
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    return [defined.create(command)]
  })
