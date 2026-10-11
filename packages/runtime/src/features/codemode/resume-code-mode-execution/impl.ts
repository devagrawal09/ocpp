import type { SessionID } from "@ocpp/schema/session-id"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: each execution the log admitted and not discarded,
// with its Session and whether it is admitted, running or settled. Duplicated
// from the other execution Slices on purpose.
export type ResumeCodeModeExecutionState = {
  executions: Record<string, { sessionID: SessionID; state: "admitted" | "running" | "settled" }>
}

export const resumeCodeModeExecutionStore = Context.Service<
  SliceStoreService<ResumeCodeModeExecutionState, ResumeCodeModeExecutionState, unknown>
>("@ocpp/runtime/ResumeCodeModeExecutionStore")

export const createResumeCodeModeExecutionState = (): ResumeCodeModeExecutionState => ({ executions: {} })

const admitted = sessionEvent("session-codemode-execution-admitted")
const started = sessionEvent("session-codemode-execution-started")
const settled = sessionEvent("session-codemode-execution-settled")
const discarded = sessionEvent("session-codemode-execution-discarded")
const resumed = sessionEvent("session-codemode-execution-resumed")

const input = Schema.toStandardSchemaV1(Schema.Struct({ executionID: Schema.String }))

export const resumeCodeModeExecution = implementCommand(specification)
  .inputSchema(input)
  .store(resumeCodeModeExecutionStore)
  .consistencyKeys({ execution: (command) => command.executionID })
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
  })
  .apply(discarded, async (event, state) => {
    delete state.executions[event.payload.executionID]
  })
  .handle(async (command, state) => {
    const execution = state.executions[command.executionID]
    if (!execution) throw new CommandRejection("execution-not-found", "Execution not found")
    if (execution.state !== "running") throw new CommandRejection("execution-not-running", "Execution not running")
    return [resumed.create({ sessionID: execution.sessionID, executionID: command.executionID })]
  })
