import { SessionFact } from "@ocpp/schema/session-fact"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted. Defining a event that exists replaces it, so this Slice needs
// no more. Duplicated from the other Code Mode event Slices on purpose.
export type DefineCodeModeEventState = {
  sessions: Record<string, "live" | "deleted">
}

export const defineCodeModeEventStore = Context.Service<
  SliceStoreService<DefineCodeModeEventState, DefineCodeModeEventState, unknown>
>("@ocpp/runtime/DefineCodeModeEventStore")

export const createDefineCodeModeEventState = (): DefineCodeModeEventState => ({ sessions: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const defined = sessionEvent("session-codemode-event-defined")

const input = Schema.toStandardSchemaV1(SessionFact.EventDefined.data)

export const defineCodeModeEvent = implementCommand(specification)
  .inputSchema(input)
  .store(defineCodeModeEventStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
  })
  .handle(async (command, state) => {
    const session = state.sessions[command.sessionID]
    if (!session) throw new Error("Session not found")
    if (session === "deleted") throw new Error("Session deleted")
    return [defined.create(command)]
  })
