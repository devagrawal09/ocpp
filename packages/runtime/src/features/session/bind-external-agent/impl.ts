import { ExternalSession } from "@ocpp/schema/external-session"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted, and each Session's binding to an external agent. Duplicated from
// the other external agent Slices on purpose.
export type BindExternalAgentState = {
  sessions: Record<string, "live" | "deleted">
  bound: Record<string, { provider: string; directory: string }>
}

export const bindExternalAgentStore = Context.Service<
  SliceStoreService<BindExternalAgentState, BindExternalAgentState, unknown>
>("@ocpp/runtime/BindExternalAgentStore")

export const createBindExternalAgentState = (): BindExternalAgentState => ({ sessions: {}, bound: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const externalBound = sessionEvent("session-external-bound")

const input = Schema.toStandardSchemaV1(ExternalSession.Bound.data)

export const bindExternalAgent = implementCommand(specification)
  .inputSchema(input)
  .store(bindExternalAgentStore)
  .consistencyKeys((command) => [command.sessionID])
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
    delete state.bound[event.payload.sessionID]
  })
  .apply(externalBound, async (event, state) => {
    state.bound[event.payload.sessionID] = { provider: event.payload.provider, directory: event.payload.directory }
  })
  .handle(async (command, state) => {
    if (!state.sessions[command.sessionID]) throw new Error("Session not found")
    if (state.sessions[command.sessionID] === "deleted") throw new Error("Session deleted")
    const bound = state.bound[command.sessionID]
    if (bound?.provider === command.provider && bound.directory === command.directory)
      throw new Error("External agent already bound")
    return [externalBound.create(command)]
  })
