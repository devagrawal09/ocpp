import type { SessionID } from "@ocpp/schema/session-id"
import { SessionFact } from "@ocpp/schema/session-fact"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: each execution the log admitted, with its Session
// and whether it is admitted, running or settled (a discarded execution never
// ran); and each
// running execution's journaled calls, by index, settled or not ("open" while
// scheduled or indeterminate). Duplicated from the other call Slices on
// purpose.
export type SettleCodeModeCallState = {
  executions: Record<string, { sessionID: SessionID; state: "admitted" | "running" | "settled" }>
  calls: Record<string, Record<number, "open" | "settled">>
}

export const settleCodeModeCallStore = Context.Service<
  SliceStoreService<SettleCodeModeCallState, SettleCodeModeCallState, unknown>
>("@ocpp/runtime/SettleCodeModeCallStore")

export const createSettleCodeModeCallState = (): SettleCodeModeCallState => ({ executions: {}, calls: {} })

const admitted = sessionEvent("session-codemode-execution-admitted")
const started = sessionEvent("session-codemode-execution-started")
const settled = sessionEvent("session-codemode-execution-settled")
const callScheduled = sessionEvent("session-codemode-call-scheduled")
const callSettled = sessionEvent("session-codemode-call-settled")
const recorded = sessionEvent("session-codemode-call-settled")

const { sessionID: _sessionID, ...call } = SessionFact.CallSettled.data.fields

const input = Schema.toStandardSchemaV1(Schema.Struct(call))

export const settleCodeModeCall = implementCommand(specification)
  .inputSchema(input)
  .store(settleCodeModeCallStore)
  .apply(admitted, async (event, state) => {
    state.executions[event.payload.executionID] = { sessionID: event.payload.sessionID, state: "admitted" }
  })
  .apply(started, async (event, state) => {
    const execution = state.executions[event.payload.executionID]
    if (execution) execution.state = "running"
  })
  .apply(settled, async (event, state) => {
    const execution = state.executions[event.payload.executionID]
    if (execution) execution.state = "settled"
    delete state.calls[event.payload.executionID]
  })
  .apply(callScheduled, async (event, state) => {
    ;(state.calls[event.payload.executionID] ??= {})[event.payload.index] = "open"
  })
  .apply(callSettled, async (event, state) => {
    const calls = state.calls[event.payload.executionID]
    if (calls?.[event.payload.index])
      calls[event.payload.index] = event.payload.outcome === "indeterminate" ? "open" : "settled"
  })
  .handle(async (command, state) => {
    const execution = state.executions[command.executionID]
    if (!execution) throw new Error("Execution not found")
    if (execution.state !== "running") throw new Error("Execution not running")
    const call = state.calls[command.executionID]?.[command.index]
    if (!call) throw new Error("Call not scheduled")
    if (call === "settled") throw new Error("Call already settled")
    return [recorded.create({ sessionID: execution.sessionID, ...command })]
  })
