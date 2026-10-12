import { SessionError } from "@ocpp/schema/session-error"
import { SessionID } from "@ocpp/schema/session-id"
import { SessionMessage } from "@ocpp/schema/session-message"
import { Tool } from "@ocpp/schema/tool"
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
// and the call ids its current attempt recorded, requested or failed. Its
// Session lifecycle is the shared fold in session/lifecycle.ts; the rest is
// duplicated on purpose.
export type FailToolInputState = {
  active: Record<string, true>
  inFlight: Record<string, { assistantMessageID: string; calls: string[] }>
}

export const failToolInputStore = Context.Service<SliceStoreService<FailToolInputState, FailToolInputState, unknown>>(
  "@ocpp/runtime/FailToolInputStore",
)

export const createFailToolInputState = (): FailToolInputState => ({
  active: {},
  inFlight: {},
})

const stepStarted = sessionEvent("session-step-started")
const toolRequested = sessionEvent("session-tool-requested")
const toolInputFailed = sessionEvent("session-tool-input-failed")

const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    sessionID: SessionID,
    assistantMessageID: SessionMessage.ID,
    id: Schema.String,
    name: Schema.String,
    // The raw input the model streamed, when it finished streaming.
    text: Schema.optional(Schema.String),
    error: SessionError.Error,
    executed: Schema.optional(Schema.Boolean),
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    content: Schema.optional(Schema.NonEmptyArray(Tool.Content)),
  }),
)

const record = (state: FailToolInputState, payload: { sessionID: string; assistantMessageID: string; id: string }) => {
  const step = state.inFlight[payload.sessionID]
  if (step?.assistantMessageID === payload.assistantMessageID) step.calls.push(payload.id)
}

export const failToolInput = implementCommand(specification)
  .inputSchema(input)
  .store(failToolInputStore, { stateVersion: 2 })
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
    record(state, event.payload)
  })
  .apply(toolInputFailed, async (event, state) => {
    record(state, event.payload)
  })
  .handle(async (command, state) => {
    if (!state.active[command.sessionID]) throw new CommandRejection("execution-not-active", "Execution not active")
    const step = state.inFlight[command.sessionID]
    if (step?.assistantMessageID !== command.assistantMessageID)
      throw new CommandRejection("step-not-in-flight", "Step not in flight")
    if (step.calls.includes(command.id))
      throw new CommandRejection("tool-call-already-recorded", "Tool call already recorded")
    return [
      toolInputFailed.create({
        sessionID: command.sessionID,
        assistantMessageID: command.assistantMessageID,
        id: command.id,
        name: command.name,
        error: command.error,
        executed: command.executed ?? false,
        ...(command.text === undefined ? {} : { text: command.text }),
        ...(command.metadata === undefined ? {} : { metadata: command.metadata }),
        ...(command.content === undefined ? {} : { content: command.content }),
      }),
    ]
  })
