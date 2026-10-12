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
  settleExecution,
  stepSettled,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: active executions, the in-flight step per Session
// and its recorded calls with whether each has settled. Its Session lifecycle
// is the shared fold in session/lifecycle.ts; the rest is duplicated on
// purpose.
export type SettleToolCallState = {
  active: Record<string, true>
  inFlight: Record<string, { assistantMessageID: string; calls: Record<string, { settled: boolean }> }>
}

export const settleToolCallStore = Context.Service<
  SliceStoreService<SettleToolCallState, SettleToolCallState, unknown>
>("@ocpp/runtime/SettleToolCallStore")

export const createSettleToolCallState = (): SettleToolCallState => ({
  active: {},
  inFlight: {},
})

const stepStarted = sessionEvent("session-step-started")
const toolRequested = sessionEvent("session-tool-requested")
const toolSettled = sessionEvent("session-tool-settled")

const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    sessionID: SessionID,
    assistantMessageID: SessionMessage.ID,
    id: Schema.String,
    // Whether execution had begun (the schema's own flag; false by default).
    executed: Schema.optional(Schema.Boolean),
    // An error settles the call as failed; otherwise content settles it as
    // success.
    error: Schema.optional(SessionError.Error),
    content: Schema.optional(Schema.NonEmptyArray(Tool.Content)),
    // UI metadata and provider continuation state, recorded as given.
    metadata: Schema.optional(Schema.Record(Schema.String, Schema.Json)),
    resultState: Schema.optional(SessionMessage.ProviderState),
  }),
)

const settleCall = (
  state: SettleToolCallState,
  payload: { sessionID: string; assistantMessageID: string; id: string },
) => {
  const call = state.inFlight[payload.sessionID]?.calls[payload.id]
  if (call && state.inFlight[payload.sessionID]?.assistantMessageID === payload.assistantMessageID) call.settled = true
}

export const settleToolCall = implementCommand(specification)
  .inputSchema(input)
  .store(settleToolCallStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(executionStarted, applyExecutionStarted)
  .apply(executionSettled, async (event, state) => {
    settleExecution(state, event.payload.sessionID)
  })
  .apply(stepStarted, async (event, state) => {
    const { sessionID, assistantMessageID } = event.payload
    state.inFlight[sessionID] = { assistantMessageID, calls: {} }
  })
  .apply(stepSettled, applyStepSettled)
  .apply(toolRequested, async (event, state) => {
    const { sessionID, assistantMessageID, id } = event.payload
    const step = state.inFlight[sessionID]
    if (step?.assistantMessageID === assistantMessageID) step.calls[id] = { settled: false }
  })
  .apply(toolSettled, async (event, state) => {
    settleCall(state, event.payload)
  })
  .handle(async (command, state) => {
    if (!state.active[command.sessionID]) throw new CommandRejection("execution-not-active", "Execution not active")
    const step = state.inFlight[command.sessionID]
    if (step?.assistantMessageID !== command.assistantMessageID)
      throw new CommandRejection("step-not-in-flight", "Step not in flight")
    const call = step.calls[command.id]
    if (!call) throw new CommandRejection("tool-call-not-recorded", "Tool call not recorded")
    if (call.settled) throw new CommandRejection("tool-call-already-settled", "Tool call already settled")
    const base = {
      sessionID: command.sessionID,
      assistantMessageID: command.assistantMessageID,
      id: command.id,
      executed: command.executed ?? false,
      ...(command.metadata === undefined ? {} : { metadata: command.metadata }),
      ...(command.resultState === undefined ? {} : { resultState: command.resultState }),
    }
    if (command.error)
      return [
        toolSettled.create({
          ...base,
          outcome: "failed",
          error: command.error,
          ...(command.content ? { content: command.content } : {}),
        }),
      ]
    if (!command.content) throw new CommandRejection("success-needs-content", "Success needs content")
    return [
      toolSettled.create({
        ...base,
        outcome: "succeeded",
        content: command.content,
      }),
    ]
  })
