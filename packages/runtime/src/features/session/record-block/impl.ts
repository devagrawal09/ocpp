import { NonNegativeInt } from "@ocpp/schema/schema"
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

// Rebuildable projection: active executions, the in-flight step per Session
// and the blocks recorded in its current attempt, as kind:ordinal keys. Its
// Session lifecycle is the shared fold in session/lifecycle.ts; the rest is
// duplicated from the other step Slices on purpose.
export type RecordBlockState = {
  active: Record<string, true>
  inFlight: Record<string, { assistantMessageID: string; blocks: string[] }>
}

export const recordBlockStore = Context.Service<SliceStoreService<RecordBlockState, RecordBlockState, unknown>>(
  "@ocpp/runtime/RecordBlockStore",
)

export const createRecordBlockState = (): RecordBlockState => ({
  active: {},
  inFlight: {},
})

const stepStarted = sessionEvent("session-step-started")
const blockRecorded = sessionEvent("session-block-recorded")

const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    sessionID: SessionID,
    assistantMessageID: SessionMessage.ID,
    kind: Schema.Literals(["text", "reasoning"]),
    ordinal: NonNegativeInt,
    text: Schema.String,
    // Provider continuation state, recorded as given.
    state: Schema.optional(SessionMessage.ProviderState),
  }),
)

const key = (block: { kind: string; ordinal: number }) => `${block.kind}:${block.ordinal}`

export const recordBlock = implementCommand(specification)
  .inputSchema(input)
  .store(recordBlockStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(executionStarted, applyExecutionStarted)
  .apply(executionSettled, async (event, state) => {
    settleExecution(state, event.payload.sessionID)
  })
  // Every step.started opens a physical attempt with fresh ordinals.
  .apply(stepStarted, async (event, state) => {
    const { sessionID, assistantMessageID } = event.payload
    state.inFlight[sessionID] = { assistantMessageID, blocks: [] }
  })
  .apply(stepSettled, applyStepSettled)
  .apply(blockRecorded, async (event, state) => {
    const step = state.inFlight[event.payload.sessionID]
    if (step?.assistantMessageID === event.payload.assistantMessageID) step.blocks.push(key(event.payload))
  })
  .handle(async (command, state) => {
    if (!state.active[command.sessionID]) throw new CommandRejection("execution-not-active", "Execution not active")
    const step = state.inFlight[command.sessionID]
    if (step?.assistantMessageID !== command.assistantMessageID)
      throw new CommandRejection("step-not-in-flight", "Step not in flight")
    if (step.blocks.includes(key(command)))
      throw new CommandRejection("block-already-recorded", "Block already recorded")
    return [
      blockRecorded.create({
        sessionID: command.sessionID,
        assistantMessageID: command.assistantMessageID,
        kind: command.kind,
        ordinal: command.ordinal,
        text: command.text,
        ...(command.state === undefined ? {} : { state: command.state }),
      }),
    ]
  })
