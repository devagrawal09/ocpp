import type { SessionID } from "@ocpp/schema/session-id"
import { SessionFact } from "@ocpp/schema/session-fact"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import { sessionDeleted } from "../../session/lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: each execution the log admitted that has not
// settled or been discarded, with its Session and whether it is admitted or
// running; and each running execution's journaled calls, by index, settled or
// not ("open" while scheduled or indeterminate). Duplicated from the other
// call Slices on purpose.
export type SettleCodeModeCallState = {
  executions: Record<string, { sessionID: SessionID; state: "admitted" | "running" }>
  calls: Record<string, Record<number, "open" | "settled">>
}

export const settleCodeModeCallStore = Context.Service<
  SliceStoreService<SettleCodeModeCallState, SettleCodeModeCallState, unknown>
>("@ocpp/runtime/SettleCodeModeCallStore")

export const createSettleCodeModeCallState = (): SettleCodeModeCallState => ({ executions: {}, calls: {} })

const admitted = sessionEvent("session-codemode-execution-admitted")
const started = sessionEvent("session-codemode-execution-started")
const settled = sessionEvent("session-codemode-execution-settled")
const discarded = sessionEvent("session-codemode-execution-discarded")
const callScheduled = sessionEvent("session-codemode-call-scheduled")
const callSettled = sessionEvent("session-codemode-call-settled")
const recorded = sessionEvent("session-codemode-call-settled")

const { sessionID: _sessionID, ...call } = SessionFact.CallSettled.data.fields

const input = Schema.toStandardSchemaV1(Schema.Struct(call))

export const settleCodeModeCall = implementCommand(specification)
  .inputSchema(input)
  .store(settleCodeModeCallStore, { stateVersion: 2 })
  // The execution's Session too, whose deletion forgets it.
  .consistencyKeys({
    execution: (command) => command.executionID,
    session: (command, state) => state.executions[command.executionID]?.sessionID,
  })
  .apply(admitted, async (event, state) => {
    state.executions[event.payload.executionID] = { sessionID: event.payload.sessionID, state: "admitted" }
  })
  .apply(started, async (event, state) => {
    const execution = state.executions[event.payload.executionID]
    if (execution) execution.state = "running"
  })
  // A settled execution is forgotten, with its calls: a later Command about it is refused as unknown, which its
  // host takes as done.
  .apply(settled, async (event, state) => {
    delete state.executions[event.payload.executionID]
    delete state.calls[event.payload.executionID]
  })
  // So is one discarded before it started.
  .apply(discarded, async (event, state) => {
    delete state.executions[event.payload.executionID]
  })
  // So is a deleted Session's, with its calls: its deletion settles them first,
  // and a fold that finds only its tombstone (the rest purged) forgets them by it.
  .apply(sessionDeleted, async (event, state) => {
    for (const [executionID, execution] of Object.entries(state.executions))
      if (execution.sessionID === event.payload.sessionID) {
        delete state.executions[executionID]
        delete state.calls[executionID]
      }
  })
  // Only a known execution's calls are kept: one settled is gone.
  .apply(callScheduled, async (event, state) => {
    if (!state.executions[event.payload.executionID]) return
    ;(state.calls[event.payload.executionID] ??= {})[event.payload.index] = "open"
  })
  .apply(callSettled, async (event, state) => {
    const calls = state.calls[event.payload.executionID]
    if (calls?.[event.payload.index])
      calls[event.payload.index] = event.payload.outcome === "indeterminate" ? "open" : "settled"
  })
  .handle(async (command, state) => {
    const execution = state.executions[command.executionID]
    if (!execution) throw new CommandRejection("execution-not-found", "Execution not found")
    if (execution.state !== "running") throw new CommandRejection("execution-not-running", "Execution not running")
    const call = state.calls[command.executionID]?.[command.index]
    if (!call) throw new CommandRejection("call-not-scheduled", "Call not scheduled")
    if (call === "settled") throw new CommandRejection("call-already-settled", "Call already settled")
    return [recorded.create({ sessionID: execution.sessionID, ...command })]
  })
