import { SessionFact } from "@ocpp/schema/session-fact"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted. Defining a command that exists replaces it, so this Slice needs
// no more. Duplicated from the other Code Mode command Slices on purpose.
export type DefineCodeModeCommandState = {
  sessions: Record<string, "live" | "deleted">
}

export const defineCodeModeCommandStore = Context.Service<
  SliceStoreService<DefineCodeModeCommandState, DefineCodeModeCommandState, unknown>
>("@ocpp/runtime/DefineCodeModeCommandStore")

export const createDefineCodeModeCommandState = (): DefineCodeModeCommandState => ({ sessions: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const defined = sessionEvent("session-codemode-command-defined")

const input = Schema.toStandardSchemaV1(SessionFact.CommandDefined.data)

export const defineCodeModeCommand = implementCommand(specification)
  .inputSchema(input)
  .store(defineCodeModeCommandStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
  })
  .handle(async (command, state) => {
    const session = state.sessions[command.sessionID]
    if (!session) throw new CommandRejection("session-not-found", "Session not found")
    if (session === "deleted") throw new CommandRejection("session-deleted", "Session deleted")
    return [defined.create(command)]
  })
