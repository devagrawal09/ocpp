import { implementQuery, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: the Sessions whose latest execution has started and
// not settled. Duplicated from session-status-query on purpose.
export type ActiveSessionsState = { active: Record<string, true> }

export const activeSessionsStore = Context.Service<
  SliceStoreService<ActiveSessionsState, ActiveSessionsState, unknown>
>("@ocpp/session-runtime/ActiveSessionsStore")

export const createActiveSessionsState = (): ActiveSessionsState => ({ active: {} })

const executionStarted = sessionEvent("session-execution-started")
const executionSettled = sessionEvent("session-execution-settled")

export const activeSessions = implementQuery(specification)
  .inputSchema(Schema.toStandardSchemaV1(Schema.Struct({})))
  .outputSchema<{ sessionIDs: string[] }>()
  .store(activeSessionsStore)
  .apply(executionStarted, async (event, state) => {
    state.active[event.payload.sessionID] = true
  })
  .apply(executionSettled, async (event, state) => {
    delete state.active[event.payload.sessionID]
  })
  .handle(async (_query, state) => ({ sessionIDs: Object.keys(state.active).sort() }))
