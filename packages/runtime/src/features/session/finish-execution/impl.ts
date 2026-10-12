import { SessionID } from "@ocpp/schema/session-id"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applyExecutionStarted,
  applyStepSettled,
  executionSettled,
  executionStarted,
  settleExecution,
  stepSettled,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: active executions and the step in flight per
// Session. Its Session lifecycle is the shared fold in session/lifecycle.ts;
// the rest is duplicated from record-step-started on purpose.
export type FinishExecutionState = {
  active: Record<string, true>
  inFlight: Record<string, string>
}

export const finishExecutionStore = Context.Service<
  SliceStoreService<FinishExecutionState, FinishExecutionState, unknown>
>("@ocpp/runtime/FinishExecutionStore")

export const createFinishExecutionState = (): FinishExecutionState => ({
  active: {},
  inFlight: {},
})

const stepStarted = sessionEvent("session-step-started")

const input = Schema.toStandardSchemaV1(Schema.Struct({ sessionID: SessionID }))

export const finishExecution = implementCommand(specification)
  .inputSchema(input)
  .store(finishExecutionStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(executionStarted, applyExecutionStarted)
  .apply(executionSettled, async (event, state) => {
    settleExecution(state, event.payload.sessionID)
  })
  .apply(stepStarted, async (event, state) => {
    const { sessionID, assistantMessageID } = event.payload
    state.inFlight[sessionID] = assistantMessageID
  })
  // A settled step is no longer in flight, even one whose failure is retried:
  // a retried attempt that produces nothing leaves the failure standing, and
  // the execution may finish.
  .apply(stepSettled, applyStepSettled)
  .handle(async (command, state) => {
    if (!state.active[command.sessionID]) throw new CommandRejection("execution-not-active", "Execution not active")
    if (state.inFlight[command.sessionID]) throw new CommandRejection("step-in-flight", "Step in flight")
    return [
      executionSettled.create({
        sessionID: command.sessionID,
        outcome: "succeeded",
      }),
    ]
  })
