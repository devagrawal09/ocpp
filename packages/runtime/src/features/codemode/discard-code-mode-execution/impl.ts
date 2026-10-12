import type { SessionID } from "@ocpp/schema/session-id"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import { forgetOwned, sessionDeleted } from "../../session/lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: each execution the log admitted that has not
// settled or been discarded, with its Session and whether it is admitted or
// running. Duplicated from the other execution Slices on purpose.
export type DiscardCodeModeExecutionState = {
  executions: Record<string, { sessionID: SessionID; state: "admitted" | "running" }>
}

export const discardCodeModeExecutionStore = Context.Service<
  SliceStoreService<DiscardCodeModeExecutionState, DiscardCodeModeExecutionState, unknown>
>("@ocpp/runtime/DiscardCodeModeExecutionStore")

export const createDiscardCodeModeExecutionState = (): DiscardCodeModeExecutionState => ({ executions: {} })

const admitted = sessionEvent("session-codemode-execution-admitted")
const started = sessionEvent("session-codemode-execution-started")
const settled = sessionEvent("session-codemode-execution-settled")
const discarded = sessionEvent("session-codemode-execution-discarded")

const input = Schema.toStandardSchemaV1(Schema.Struct({ executionID: Schema.String }))

export const discardCodeModeExecution = implementCommand(specification)
  .inputSchema(input)
  .store(discardCodeModeExecutionStore, { stateVersion: 2 })
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
  // A settled execution is forgotten: a later Command about it is refused as unknown, which its host takes as
  // done.
  .apply(settled, async (event, state) => {
    delete state.executions[event.payload.executionID]
  })
  .apply(discarded, async (event, state) => {
    delete state.executions[event.payload.executionID]
  })
  // So is a deleted Session's: its deletion settles them first, and a fold that
  // finds only its tombstone (the rest purged) forgets them by it.
  .apply(sessionDeleted, async (event, state) => {
    forgetOwned(event.payload.sessionID, state.executions)
  })
  .handle(async (command, state) => {
    const execution = state.executions[command.executionID]
    if (!execution) throw new CommandRejection("execution-not-found", "Execution not found")
    if (execution.state !== "admitted")
      throw new CommandRejection("execution-already-started", "Execution already started")
    return [discarded.create({ sessionID: execution.sessionID, executionID: command.executionID })]
  })
