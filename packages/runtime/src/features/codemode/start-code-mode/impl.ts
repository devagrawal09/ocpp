import { SessionEvent } from "@ocpp/schema/session-event"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applySessionCreated,
  applySessionDeleted,
  forgetValued,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
} from "../../session/lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or deleted;
// the Session of each execution the log admitted; and the executions that went
// to the background, with their Session. Its Session lifecycle is the shared
// fold in session/lifecycle.ts; the rest is duplicated from the other Code
// Mode lifecycle Slices on purpose.
export type StartCodeModeState = {
  sessions: Record<string, "live" | "deleted">
  executions: Record<string, string>
  started: Record<string, string>
}

export const startCodeModeStore = Context.Service<SliceStoreService<StartCodeModeState, StartCodeModeState, unknown>>(
  "@ocpp/runtime/StartCodeModeStore",
)

export const createStartCodeModeState = (): StartCodeModeState => ({ sessions: {}, executions: {}, started: {} })

const executionAdmitted = sessionEvent("session-codemode-execution-admitted")
const codeModeStarted = sessionEvent("session-codemode-started")

const input = Schema.toStandardSchemaV1(SessionEvent.CodeMode.Started.data)

export const startCodeMode = implementCommand(specification)
  .inputSchema(input)
  .store(startCodeModeStore, { stateVersion: 2 })
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  // A deleted Session is forgotten but for its tombstone.
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
    forgetValued(event.payload.sessionID, state.executions, state.started)
  })
  .apply(executionAdmitted, async (event, state) => {
    state.executions[event.payload.executionID] = event.payload.sessionID
  })
  .apply(codeModeStarted, async (event, state) => {
    state.started[event.payload.executionID] = event.payload.sessionID
  })
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    if (state.executions[command.executionID] !== command.sessionID)
      throw new CommandRejection("execution-not-found", "Execution not found")
    if (state.started[command.executionID])
      throw new CommandRejection("code-mode-already-started", "Code Mode already started")
    return [codeModeStarted.create(command)]
  })
