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
// Defining a command that exists replaces it, so this Slice needs no more. Its
// Session lifecycle is the shared fold in session/lifecycle.ts; the rest is
// duplicated from the other Code Mode command Slices on purpose.
export type DefineCodeModeCommandState = {
  sessions: Record<string, "live" | "deleted">
}

export const defineCodeModeCommandStore = Context.Service<
  SliceStoreService<DefineCodeModeCommandState, DefineCodeModeCommandState, unknown>
>("@ocpp/runtime/DefineCodeModeCommandStore")

export const createDefineCodeModeCommandState = (): DefineCodeModeCommandState => ({ sessions: {} })

const defined = sessionEvent("session-codemode-command-defined")

const input = Schema.toStandardSchemaV1(SessionFact.CommandDefined.data)

export const defineCodeModeCommand = implementCommand(specification)
  .inputSchema(input)
  .store(defineCodeModeCommandStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, applySessionDeleted)
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    return [defined.create(command)]
  })
