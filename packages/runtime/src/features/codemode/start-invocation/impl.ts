import { SessionEvent } from "@ocpp/schema/session-event"
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
// the Session of each execution the log admitted; and the executions an
// invocation owns. Its Session lifecycle is the shared fold in
// session/lifecycle.ts; the rest is duplicated from the other Code Mode
// lifecycle Slices on purpose.
export type StartInvocationState = {
  sessions: Record<string, "live" | "deleted">
  executions: Record<string, string>
  started: Record<string, true>
}

export const startInvocationStore = Context.Service<
  SliceStoreService<StartInvocationState, StartInvocationState, unknown>
>("@ocpp/runtime/StartInvocationStore")

export const createStartInvocationState = (): StartInvocationState => ({ sessions: {}, executions: {}, started: {} })

const executionAdmitted = sessionEvent("session-codemode-execution-admitted")
const invocationStarted = sessionEvent("session-invocation-started")

const input = Schema.toStandardSchemaV1(SessionEvent.Invocation.Started.data)

export const startInvocation = implementCommand(specification)
  .inputSchema(input)
  .store(startInvocationStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, applySessionDeleted)
  .apply(executionAdmitted, async (event, state) => {
    state.executions[event.payload.executionID] = event.payload.sessionID
  })
  .apply(invocationStarted, async (event, state) => {
    state.started[event.payload.executionID] = true
  })
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    if (state.executions[command.executionID] !== command.sessionID)
      throw new CommandRejection("execution-not-found", "Execution not found")
    if (state.started[command.executionID])
      throw new CommandRejection("invocation-already-started", "Invocation already started")
    return [invocationStarted.create(command)]
  })
