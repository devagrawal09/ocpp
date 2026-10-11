import { SessionEvent } from "@ocpp/schema/session-event"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted; the Session of each execution the log admitted; and the
// executions that went to the background. Duplicated from the other Code
// Mode lifecycle Slices on purpose.
export type StartCodeModeState = {
  sessions: Record<string, "live" | "deleted">
  executions: Record<string, string>
  started: Record<string, true>
}

export const startCodeModeStore = Context.Service<SliceStoreService<StartCodeModeState, StartCodeModeState, unknown>>(
  "@ocpp/runtime/StartCodeModeStore",
)

export const createStartCodeModeState = (): StartCodeModeState => ({ sessions: {}, executions: {}, started: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const executionAdmitted = sessionEvent("session-codemode-execution-admitted")
const codeModeStarted = sessionEvent("session-codemode-started")

const input = Schema.toStandardSchemaV1(SessionEvent.CodeMode.Started.data)

export const startCodeMode = implementCommand(specification)
  .inputSchema(input)
  .store(startCodeModeStore)
  .consistencyKeys((command) => [command.sessionID])
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
  })
  .apply(executionAdmitted, async (event, state) => {
    state.executions[event.payload.executionID] = event.payload.sessionID
  })
  .apply(codeModeStarted, async (event, state) => {
    state.started[event.payload.executionID] = true
  })
  .handle(async (command, state) => {
    const session = state.sessions[command.sessionID]
    if (!session) throw new Error("Session not found")
    if (session === "deleted") throw new Error("Session deleted")
    if (state.executions[command.executionID] !== command.sessionID) throw new Error("Execution not found")
    if (state.started[command.executionID]) throw new Error("Code Mode already started")
    return [codeModeStarted.create(command)]
  })
