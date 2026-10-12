import type { SessionID } from "@ocpp/schema/session-id"
import { SessionFact } from "@ocpp/schema/session-fact"
import { NonNegativeInt } from "@ocpp/schema/schema"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import { forgetOwned, forgetSession, sessionDeleted } from "../../session/lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: each execution the log admitted that has not
// settled or been discarded, with its Session and the names it holds; and each
// live Session's notebook, the names its executions saved with the size of
// each value. A revert's fact names the executions whose values it removes; a
// fork's carries the values it copies. Duplicated from
// admit-code-mode-execution on purpose.
export type SettleCodeModeExecutionState = {
  executions: Record<string, { sessionID: SessionID; reserved: string[] }>
  notebooks: Record<string, Record<string, { execution: string; bytes: number }>>
}

export const settleCodeModeExecutionStore = Context.Service<
  SliceStoreService<SettleCodeModeExecutionState, SettleCodeModeExecutionState, unknown>
>("@ocpp/runtime/SettleCodeModeExecutionStore")

export const createSettleCodeModeExecutionState = (): SettleCodeModeExecutionState => ({
  executions: {},
  notebooks: {},
})

const admitted = sessionEvent("session-codemode-execution-admitted")
const settled = sessionEvent("session-codemode-execution-settled")
const discarded = sessionEvent("session-codemode-execution-discarded")
const notebookCopied = sessionEvent("session-codemode-notebook-copied")
const notebookReverted = sessionEvent("session-codemode-notebook-reverted")

const { sessionID: _sessionID, ...settlement } = SessionFact.ExecutionSettled.data.fields

const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    ...settlement,
    // How many values, and how many bytes of them, the Session's notebook may hold.
    limits: Schema.Struct({ values: NonNegativeInt, bytes: NonNegativeInt }),
  }),
)

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) ?? "null").byteLength

// Why the notebook cannot take the values, or undefined when it can.
const overflow = (count: number, size: number, limits: { readonly values: number; readonly bytes: number }) => {
  if (count > limits.values)
    return `This Session's notebook would hold ${count} values, above the limit of ${limits.values}. Notebook names are permanent, so free space by reverting messages that saved values you no longer need.`
  if (size > limits.bytes)
    return `This Session's notebook would hold ${size} bytes, above the limit of ${limits.bytes}. Publish smaller summaries and keep large artifacts in files through host tools.`
  return undefined
}

export const settleCodeModeExecution = implementCommand(specification)
  .inputSchema(input)
  .store(settleCodeModeExecutionStore, { stateVersion: 3 })
  // The execution's Session, whose notebook the settlement reads.
  .consistencyKeys({
    execution: (command) => command.executionID,
    session: (command, state) => state.executions[command.executionID]?.sessionID,
  })
  .apply(admitted, async (event, state) => {
    const { sessionID, executionID, reserved } = event.payload
    state.executions[executionID] = { sessionID, reserved: [...reserved] }
  })
  .apply(settled, async (event, state) => {
    const { sessionID, executionID } = event.payload
    // A settled execution is forgotten: a later settlement is refused as unknown, and its host reads how it
    // settled from its own record.
    delete state.executions[executionID]
    if (event.payload.outcome !== "finished") return
    const notebook = (state.notebooks[sessionID] ??= {})
    for (const [name, value] of Object.entries(event.payload.values ?? {}))
      notebook[name] = { execution: executionID, bytes: bytes(value) }
  })
  .apply(discarded, async (event, state) => {
    delete state.executions[event.payload.executionID]
  })
  // A deleted Session is forgotten, its notebook with it.
  .apply(sessionDeleted, async (event, state) => {
    forgetSession(event.payload.sessionID, state.notebooks)
    forgetOwned(event.payload.sessionID, state.executions)
  })
  // A fork's notebook holds the values its copy carries, each its parent's execution's.
  .apply(notebookCopied, async (event, state) => {
    const notebook = (state.notebooks[event.payload.sessionID] ??= {})
    for (const [name, entry] of Object.entries(event.payload.values))
      notebook[name] = { execution: entry.executionID, bytes: bytes(entry.value) }
  })
  .apply(notebookReverted, async (event, state) => {
    const notebook = state.notebooks[event.payload.sessionID] ?? {}
    for (const [name, entry] of Object.entries(notebook))
      if (event.payload.executions.includes(entry.execution)) delete notebook[name]
  })
  .handle(async (command, state) => {
    const { limits, ...settlement } = command
    const execution = state.executions[settlement.executionID]
    if (!execution) throw new CommandRejection("execution-not-found", "Execution not found")
    const { sessionID } = execution
    if (settlement.outcome !== "finished") return [settled.create({ sessionID, ...settlement })]
    const values = settlement.values ?? {}
    const names = Object.keys(values)
    const lost = names.filter((name) => !execution.reserved.includes(name))
    const notebook = Object.values(state.notebooks[sessionID] ?? {})
    const full = overflow(
      notebook.length + names.length,
      notebook.reduce((total, entry) => total + entry.bytes, 0) +
        Object.values(values).reduce<number>((total, value) => total + bytes(value), 0),
      limits,
    )
    const error =
      lost.length > 0
        ? `Notebook names ${lost.join(", ")} are no longer reserved by this execution; nothing was saved.`
        : full === undefined
          ? undefined
          : `${full} Nothing was saved.`
    if (error === undefined) return [settled.create({ sessionID, ...settlement })]
    return [settled.create({ sessionID, executionID: settlement.executionID, outcome: "failed", error })]
  })
