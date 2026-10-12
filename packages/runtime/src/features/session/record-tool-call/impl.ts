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
  forgetSession,
  sessionDeleted,
  settleExecution,
  stepSettled,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: active executions, the in-flight step per Session
// and the call ids recorded in its current attempt. Its Session lifecycle is
// the shared fold in session/lifecycle.ts; the rest is duplicated on purpose.
export type RecordToolCallState = {
  active: Record<string, true>
  inFlight: Record<string, { assistantMessageID: string; calls: string[] }>
}

export const recordToolCallStore = Context.Service<
  SliceStoreService<RecordToolCallState, RecordToolCallState, unknown>
>("@ocpp/runtime/RecordToolCallStore")

export const createRecordToolCallState = (): RecordToolCallState => ({
  active: {},
  inFlight: {},
})

const stepStarted = sessionEvent("session-step-started")
const toolRequested = sessionEvent("session-tool-requested")

const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    sessionID: SessionID,
    assistantMessageID: SessionMessage.ID,
    id: Schema.String,
    name: Schema.String,
    input: Schema.Record(Schema.String, Schema.Unknown),
    // Whether the provider executes the call itself (false by default).
    executed: Schema.optional(Schema.Boolean),
    // Provider continuation state, recorded as given.
    state: Schema.optional(SessionMessage.ProviderState),
  }),
)

export const recordToolCall = implementCommand(specification)
  .inputSchema(input)
  .store(recordToolCallStore, { stateVersion: 2 })
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(executionStarted, applyExecutionStarted)
  // A deleted Session is forgotten.
  .apply(sessionDeleted, async (event, state) => {
    forgetSession(event.payload.sessionID, state.active, state.inFlight)
  })
  .apply(executionSettled, async (event, state) => {
    settleExecution(state, event.payload.sessionID)
  })
  .apply(stepStarted, async (event, state) => {
    const { sessionID, assistantMessageID } = event.payload
    state.inFlight[sessionID] = { assistantMessageID, calls: [] }
  })
  .apply(stepSettled, applyStepSettled)
  .apply(toolRequested, async (event, state) => {
    const { sessionID, assistantMessageID, id } = event.payload
    const step = state.inFlight[sessionID]
    if (step?.assistantMessageID === assistantMessageID) step.calls.push(id)
  })
  .handle(async (command, state) => {
    if (!state.active[command.sessionID]) throw new CommandRejection("execution-not-active", "Execution not active")
    const step = state.inFlight[command.sessionID]
    if (step?.assistantMessageID !== command.assistantMessageID)
      throw new CommandRejection("step-not-in-flight", "Step not in flight")
    if (step.calls.includes(command.id))
      throw new CommandRejection("tool-call-already-recorded", "Tool call already recorded")
    return [
      toolRequested.create({
        sessionID: command.sessionID,
        assistantMessageID: command.assistantMessageID,
        id: command.id,
        name: command.name,
        input: command.input,
        executed: command.executed ?? false,
        ...(command.state === undefined ? {} : { state: command.state }),
      }),
    ]
  })
