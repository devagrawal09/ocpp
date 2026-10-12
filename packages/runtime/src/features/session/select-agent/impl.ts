import { Agent } from "@ocpp/schema/agent"
import { SessionID } from "@ocpp/schema/session-id"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applySessionCreated,
  applySessionDeleted,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
  type SessionsState,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session the log has named, live or deleted
// (the shared Session lifecycle), and the agent each live Session runs as.
export type SelectAgentState = SessionsState & { agents: Record<string, string> }

export const selectAgentStore = Context.Service<SliceStoreService<SelectAgentState, SelectAgentState, unknown>>(
  "@ocpp/runtime/SelectAgentStore",
)

export const createSelectAgentState = (): SelectAgentState => ({ sessions: {}, agents: {} })

const agentSelected = sessionEvent("session-agent-selected")

const input = Schema.toStandardSchemaV1(Schema.Struct({ sessionID: SessionID, agent: Agent.ID }))

export const selectAgent = implementCommand(specification)
  .inputSchema(input)
  .store(selectAgentStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, async (event, state) => {
    await applySessionCreated(event, state)
    if (event.payload.agent !== undefined) state.agents[event.payload.sessionID] = event.payload.agent
  })
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
    delete state.agents[event.payload.sessionID]
  })
  .apply(agentSelected, async (event, state) => {
    if (state.sessions[event.payload.sessionID]) state.agents[event.payload.sessionID] = event.payload.agent
  })
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    const previous = state.agents[command.sessionID]
    return [
      agentSelected.create({
        sessionID: command.sessionID,
        agent: command.agent,
        ...(previous === undefined ? {} : { previous: Agent.ID.make(previous) }),
      }),
    ]
  })
