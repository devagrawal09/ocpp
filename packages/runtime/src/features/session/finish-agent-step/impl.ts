import { LLM } from "@ocpp/schema/llm"
import { Money } from "@ocpp/schema/money"
import { SessionError } from "@ocpp/schema/session-error"
import { SessionID } from "@ocpp/schema/session-id"
import { SessionMessage } from "@ocpp/schema/session-message"
import { TokenUsage } from "@ocpp/schema/token-usage"
import { NonNegativeInt } from "@ocpp/schema/schema"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applyExecutionStarted,
  applySessionCreated,
  applySessionDeleted,
  applyStepSettled,
  executionSettled,
  executionStarted,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
  settleExecution,
  stepSettled,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or deleted,
// the Sessions with an active execution, and per Session the step in flight
// with its calls still open. Its Session lifecycle is the shared fold in
// session/lifecycle.ts; the rest is duplicated from the runtime's own step
// Slices on purpose.
export type FinishAgentStepState = {
  sessions: Record<string, "live" | "deleted">
  active: Record<string, true>
  inFlight: Record<string, { assistantMessageID: string; open: Record<string, true> }>
}

export const finishAgentStepStore = Context.Service<
  SliceStoreService<FinishAgentStepState, FinishAgentStepState, unknown>
>("@ocpp/runtime/FinishAgentStepStore")

export const createFinishAgentStepState = (): FinishAgentStepState => ({ sessions: {}, active: {}, inFlight: {} })

const stepStarted = sessionEvent("session-step-started")
const toolRequested = sessionEvent("session-tool-requested")
const toolSettled = sessionEvent("session-tool-settled")
const blockRecorded = sessionEvent("session-block-recorded")

const finished = {
  sessionID: SessionID,
  assistantMessageID: SessionMessage.ID,
  // The agent's finished text and reasoning, in order.
  blocks: Schema.Array(
    Schema.Struct({ kind: Schema.Literals(["text", "reasoning"]), ordinal: NonNegativeInt, text: Schema.String }),
  ),
  // The calls the agent left without a result.
  calls: Schema.Array(Schema.Struct({ id: Schema.String, executed: Schema.Boolean, error: SessionError.Error })),
}
const input = Schema.toStandardSchemaV1(
  Schema.Union([
    Schema.Struct({
      ...finished,
      outcome: Schema.Literal("succeeded"),
      finish: LLM.FinishReason,
      cost: Money.USD,
      tokens: TokenUsage.Info,
    }),
    Schema.Struct({
      ...finished,
      outcome: Schema.Literal("failed"),
      error: SessionError.Error,
      cost: Schema.optional(Money.USD),
      tokens: Schema.optional(TokenUsage.Info),
    }),
  ]),
)

export const finishAgentStep = implementCommand(specification)
  .inputSchema(input)
  .store(finishAgentStepStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
    settleExecution(state, event.payload.sessionID)
  })
  .apply(executionStarted, applyExecutionStarted)
  .apply(executionSettled, async (event, state) => {
    settleExecution(state, event.payload.sessionID)
  })
  .apply(stepStarted, async (event, state) => {
    state.inFlight[event.payload.sessionID] = { assistantMessageID: event.payload.assistantMessageID, open: {} }
  })
  .apply(stepSettled, applyStepSettled)
  .apply(toolRequested, async (event, state) => {
    const step = state.inFlight[event.payload.sessionID]
    if (step?.assistantMessageID === event.payload.assistantMessageID) step.open[event.payload.id] = true
  })
  .apply(toolSettled, async (event, state) => {
    const step = state.inFlight[event.payload.sessionID]
    if (step?.assistantMessageID === event.payload.assistantMessageID) delete step.open[event.payload.id]
  })
  .handle(async (command, state) => {
    const { blocks, calls, ...outcome } = command
    const { sessionID, assistantMessageID } = outcome
    requireLiveSession(state, sessionID)
    if (!state.active[sessionID]) throw new CommandRejection("execution-not-active", "Execution not active")
    const step = state.inFlight[sessionID]
    if (step?.assistantMessageID !== assistantMessageID)
      throw new CommandRejection("step-not-in-flight", "Step not in flight")
    return [
      ...blocks.map((block) => blockRecorded.create({ sessionID, assistantMessageID, ...block })),
      ...calls
        .filter((call) => step.open[call.id])
        .map((call) => toolSettled.create({ sessionID, assistantMessageID, outcome: "failed", ...call })),
      stepSettled.create(outcome),
    ]
  })
