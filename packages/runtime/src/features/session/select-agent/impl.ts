import { Agent } from "@ocpp/schema/agent"
import { SessionID } from "@ocpp/schema/session-id"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session the log has named, live or deleted,
// with the agent it runs as. Duplicated from the other Session Slices on
// purpose.
export type SelectAgentState = {
  sessions: Record<string, { status: "live" | "deleted"; agent?: string }>
}

export const selectAgentStore = Context.Service<SliceStoreService<SelectAgentState, SelectAgentState, unknown>>(
  "@ocpp/runtime/SelectAgentStore",
)

export const createSelectAgentState = (): SelectAgentState => ({ sessions: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const agentSelected = sessionEvent("session-agent-selected")

const input = Schema.toStandardSchemaV1(Schema.Struct({ sessionID: SessionID, agent: Agent.ID }))

export const selectAgent = implementCommand(specification)
  .inputSchema(input)
  .store(selectAgentStore)
  .consistencyKeys((command) => [command.sessionID])
  .apply(sessionCreated, async (event, state) => {
    const agent = event.payload.agent
    state.sessions[event.payload.sessionID] = { status: "live", ...(agent === undefined ? {} : { agent }) }
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = { status: "deleted" }
  })
  .apply(agentSelected, async (event, state) => {
    const session = state.sessions[event.payload.sessionID]
    if (session) session.agent = event.payload.agent
  })
  .handle(async (command, state) => {
    const session = state.sessions[command.sessionID]
    if (!session) throw new Error("Session not found")
    if (session.status === "deleted") throw new Error("Session deleted")
    return [
      agentSelected.create({
        sessionID: command.sessionID,
        agent: command.agent,
        ...(session.agent === undefined ? {} : { previous: Agent.ID.make(session.agent) }),
      }),
    ]
  })
