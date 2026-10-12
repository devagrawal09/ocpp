import { SessionID } from "@ocpp/schema/session-id"
import { SessionMessage } from "@ocpp/schema/session-message"
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

// Rebuildable projection: active executions and the in-flight step per
// Session, with whether its current attempt has streamed. Its Session
// lifecycle is the shared fold in session/lifecycle.ts; the rest is duplicated
// from the other step Slices on purpose.
export type RecordStepStreamedState = {
  active: Record<string, true>
  inFlight: Record<string, { assistantMessageID: string; streamed: boolean }>
}

export const recordStepStreamedStore = Context.Service<
  SliceStoreService<RecordStepStreamedState, RecordStepStreamedState, unknown>
>("@ocpp/runtime/RecordStepStreamedStore")

export const createRecordStepStreamedState = (): RecordStepStreamedState => ({
  active: {},
  inFlight: {},
})

const stepStarted = sessionEvent("session-step-started")
const stepStreamed = sessionEvent("session-step-streamed")

const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    sessionID: SessionID,
    assistantMessageID: SessionMessage.ID,
  }),
)

export const recordStepStreamed = implementCommand(specification)
  .inputSchema(input)
  .store(recordStepStreamedStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(executionStarted, applyExecutionStarted)
  .apply(executionSettled, async (event, state) => {
    settleExecution(state, event.payload.sessionID)
  })
  // Every step.started opens a physical attempt, which streams once.
  .apply(stepStarted, async (event, state) => {
    const { sessionID, assistantMessageID } = event.payload
    state.inFlight[sessionID] = { assistantMessageID, streamed: false }
  })
  .apply(stepStreamed, async (event, state) => {
    const step = state.inFlight[event.payload.sessionID]
    if (step?.assistantMessageID === event.payload.assistantMessageID) step.streamed = true
  })
  .apply(stepSettled, applyStepSettled)
  .handle(async (command, state) => {
    if (!state.active[command.sessionID]) throw new CommandRejection("execution-not-active", "Execution not active")
    const step = state.inFlight[command.sessionID]
    if (step?.assistantMessageID !== command.assistantMessageID)
      throw new CommandRejection("step-not-in-flight", "Step not in flight")
    if (step.streamed) throw new CommandRejection("step-already-streamed", "Step already streamed")
    return [
      stepStreamed.create({
        sessionID: command.sessionID,
        assistantMessageID: command.assistantMessageID,
      }),
    ]
  })
