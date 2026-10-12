import { SessionEvent } from "@ocpp/schema/session-event"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applyExecutionSettled,
  applyExecutionStarted,
  applySessionCreated,
  applySessionDeleted,
  executionSettled,
  executionStarted,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or deleted,
// and the Sessions with an active execution. Its Session lifecycle is the
// shared fold in session/lifecycle.ts; the rest is duplicated from the other
// Session Slices on purpose.
export type StartAgentStepState = {
  sessions: Record<string, "live" | "deleted">
  active: Record<string, true>
}

export const startAgentStepStore = Context.Service<
  SliceStoreService<StartAgentStepState, StartAgentStepState, unknown>
>("@ocpp/runtime/StartAgentStepStore")

export const createStartAgentStepState = (): StartAgentStepState => ({ sessions: {}, active: {} })

const stepStarted = sessionEvent("session-step-started")

const input = Schema.toStandardSchemaV1(SessionEvent.Step.Started.data)

export const startAgentStep = implementCommand(specification)
  .inputSchema(input)
  .store(startAgentStepStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, applySessionDeleted)
  .apply(executionStarted, applyExecutionStarted)
  .apply(executionSettled, applyExecutionSettled)
  // Deliberately a no-op: a step in flight does not hold the next one back,
  // so the scenario that starts two needs no state.
  .apply(stepStarted, async () => {})
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    if (!state.active[command.sessionID]) throw new CommandRejection("execution-not-active", "Execution not active")
    return [stepStarted.create(command)]
  })
