import { ExternalSession } from "@ocpp/schema/external-session"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
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

// Rebuildable projection: every Session ID the log has named, live or deleted,
// and each Session's binding to an external agent. Its Session lifecycle is
// the shared fold in session/lifecycle.ts; the rest is duplicated from the
// other external agent Slices on purpose.
export type BindExternalAgentState = {
  sessions: Record<string, "live" | "deleted">
  bound: Record<string, { provider: string; directory: string }>
}

export const bindExternalAgentStore = Context.Service<
  SliceStoreService<BindExternalAgentState, BindExternalAgentState, unknown>
>("@ocpp/runtime/BindExternalAgentStore")

export const createBindExternalAgentState = (): BindExternalAgentState => ({ sessions: {}, bound: {} })

const externalBound = sessionEvent("session-external-bound")

const input = Schema.toStandardSchemaV1(ExternalSession.Bound.data)

export const bindExternalAgent = implementCommand(specification)
  .inputSchema(input)
  .store(bindExternalAgentStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
    delete state.bound[event.payload.sessionID]
  })
  .apply(externalBound, async (event, state) => {
    state.bound[event.payload.sessionID] = { provider: event.payload.provider, directory: event.payload.directory }
  })
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    const bound = state.bound[command.sessionID]
    if (bound?.provider === command.provider && bound.directory === command.directory)
      throw new CommandRejection("external-agent-already-bound", "External agent already bound")
    return [externalBound.create(command)]
  })
