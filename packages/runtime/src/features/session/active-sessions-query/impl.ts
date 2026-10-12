import { implementQuery, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { applyExecutionSettled, applyExecutionStarted, executionSettled, executionStarted } from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: the Sessions whose latest execution has started and
// not settled. Its Session lifecycle is the shared fold in
// session/lifecycle.ts; the rest is duplicated from session-status-query on
// purpose.
export type ActiveSessionsState = { active: Record<string, true> }

export const activeSessionsStore = Context.Service<
  SliceStoreService<ActiveSessionsState, ActiveSessionsState, unknown>
>("@ocpp/runtime/ActiveSessionsStore")

export const createActiveSessionsState = (): ActiveSessionsState => ({ active: {} })

export const activeSessions = implementQuery(specification)
  .inputSchema(Schema.toStandardSchemaV1(Schema.Struct({})))
  .outputSchema<{ sessionIDs: string[] }>()
  .store(activeSessionsStore)
  .apply(executionStarted, applyExecutionStarted)
  .apply(executionSettled, applyExecutionSettled)
  .handle(async (_query, state) => ({ sessionIDs: Object.keys(state.active).sort() }))
