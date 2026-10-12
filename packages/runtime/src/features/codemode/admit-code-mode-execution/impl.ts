import type { SessionID } from "@ocpp/schema/session-id"
import { SessionFact } from "@ocpp/schema/session-fact"
import { NonNegativeInt } from "@ocpp/schema/schema"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applySessionCreated,
  applySessionDeleted,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
} from "../../session/lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or deleted;
// each execution the log admitted, with its Session and the names it holds
// until it settles; each Session's notebook, the names its executions saved
// with the size of each value; and each Session's reserved names. A revert's
// and a fork's facts name the executions whose values they remove or copy. Its
// Session lifecycle is the shared fold in session/lifecycle.ts; the rest is
// duplicated from settle-code-mode-execution on purpose.
export type AdmitCodeModeExecutionState = {
  sessions: Record<string, "live" | "deleted">
  executions: Record<string, { sessionID: SessionID; reserved: string[] }>
  notebooks: Record<string, Record<string, { execution: string; bytes: number }>>
  reservations: Record<string, Record<string, string>>
}

export const admitCodeModeExecutionStore = Context.Service<
  SliceStoreService<AdmitCodeModeExecutionState, AdmitCodeModeExecutionState, unknown>
>("@ocpp/runtime/AdmitCodeModeExecutionStore")

export const createAdmitCodeModeExecutionState = (): AdmitCodeModeExecutionState => ({
  sessions: {},
  executions: {},
  notebooks: {},
  reservations: {},
})

const admitted = sessionEvent("session-codemode-execution-admitted")
const settled = sessionEvent("session-codemode-execution-settled")
const discarded = sessionEvent("session-codemode-execution-discarded")
const notebookCopied = sessionEvent("session-codemode-notebook-copied")
const notebookReverted = sessionEvent("session-codemode-notebook-reverted")

const { snapshot: _snapshot, ...admission } = SessionFact.ExecutionAdmitted.data.fields

const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    ...admission,
    // How many values, and how many bytes of them, the Session's notebook may hold.
    limits: Schema.Struct({ values: NonNegativeInt, bytes: NonNegativeInt }),
  }),
)

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) ?? "null").byteLength

const release = (state: AdmitCodeModeExecutionState, executionID: string) => {
  const execution = state.executions[executionID]
  const reservations = execution ? state.reservations[execution.sessionID] : undefined
  if (!execution || !reservations) return
  for (const name of execution.reserved) if (reservations[name] === executionID) delete reservations[name]
  execution.reserved = []
}

export const admitCodeModeExecution = implementCommand(specification)
  .inputSchema(input)
  .store(admitCodeModeExecutionStore)
  .consistencyKeys({ session: (command) => command.sessionID, execution: (command) => command.executionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, applySessionDeleted)
  .apply(admitted, async (event, state) => {
    const { sessionID, executionID, reserved } = event.payload
    state.executions[executionID] = { sessionID, reserved: [...reserved] }
    const reservations = (state.reservations[sessionID] ??= {})
    for (const name of reserved) reservations[name] = executionID
  })
  .apply(settled, async (event, state) => {
    const { sessionID, executionID } = event.payload
    release(state, executionID)
    if (event.payload.outcome !== "finished") return
    const notebook = (state.notebooks[sessionID] ??= {})
    for (const [name, value] of Object.entries(event.payload.values ?? {}))
      notebook[name] = { execution: executionID, bytes: bytes(value) }
  })
  .apply(discarded, async (event, state) => {
    release(state, event.payload.executionID)
    delete state.executions[event.payload.executionID]
  })
  .apply(notebookCopied, async (event, state) => {
    const { sessionID, parentID, executions } = event.payload
    const notebook = (state.notebooks[sessionID] ??= {})
    for (const [name, entry] of Object.entries(state.notebooks[parentID] ?? {}))
      if (executions.includes(entry.execution)) notebook[name] = entry
  })
  .apply(notebookReverted, async (event, state) => {
    const notebook = state.notebooks[event.payload.sessionID] ?? {}
    for (const [name, entry] of Object.entries(notebook))
      if (event.payload.executions.includes(entry.execution)) delete notebook[name]
  })
  .handle(async (command, state) => {
    const { limits, ...admission } = command
    requireLiveSession(state, admission.sessionID)
    if (state.executions[admission.executionID])
      throw new CommandRejection("execution-already-admitted", "Execution already admitted")
    const notebook = state.notebooks[admission.sessionID] ?? {}
    const names = Object.keys(notebook)
    const size = Object.values(notebook).reduce((total, entry) => total + entry.bytes, 0)
    // Each refusal names what the host tells the program: the notebook's size, or the names in the way.
    const values = names.length + admission.reserved.length
    if (values > limits.values || size > limits.bytes)
      throw new CommandRejection("notebook-full", "Notebook full", { values, bytes: size })
    const defined = admission.reserved.filter((name) => notebook[name])
    if (defined.length > 0)
      throw new CommandRejection("name-already-defined", "Name already defined", { names: defined })
    const reservations = state.reservations[admission.sessionID] ?? {}
    const reserved = admission.reserved.filter((name) => reservations[name])
    if (reserved.length > 0)
      throw new CommandRejection("name-reserved", "Name reserved", {
        names: reserved,
        owner: reservations[reserved[0]!],
      })
    return [admitted.create({ ...admission, snapshot: names })]
  })
