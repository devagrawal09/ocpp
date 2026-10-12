import { SessionID } from "@ocpp/schema/session-id"
import type { SessionMessage } from "@ocpp/schema/session-message"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applyExecutionStarted,
  applySessionCreated,
  applySessionDeleted,
  applyStepSettled,
  executionSettled,
  executionStarted,
  forgetSession,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
  settleExecution,
  stepSettled,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or deleted;
// each Session's active execution, its in-flight step and the open tool calls
// of that step (as interrupt-execution keeps them); and its pending inbox
// items in admission order; its Code Mode executions that have not settled,
// in admission order; and the background job markers it owns that have not
// completed, in start order. Its Session lifecycle is the shared fold in
// session/lifecycle.ts; the rest is duplicated on purpose.
export type DeleteSessionState = {
  sessions: Record<string, "live" | "deleted">
  active: Record<string, true>
  inFlight: Record<string, SessionMessage.ID>
  openCalls: Record<string, OpenCall[]>
  pending: Record<string, SessionMessage.ID[]>
  executions: Record<string, string[]>
  markers: Record<string, SessionMessage.ID[]>
}
type OpenCall = {
  assistantMessageID: SessionMessage.ID
  id: string
  name: string
  executed: boolean
}

export const deleteSessionStore = Context.Service<SliceStoreService<DeleteSessionState, DeleteSessionState, unknown>>(
  "@ocpp/runtime/DeleteSessionStore",
)

export const createDeleteSessionState = (): DeleteSessionState => ({
  sessions: {},
  active: {},
  inFlight: {},
  openCalls: {},
  pending: {},
  executions: {},
  markers: {},
})

const stepStarted = sessionEvent("session-step-started")
const toolRequested = sessionEvent("session-tool-requested")
const toolSettled = sessionEvent("session-tool-settled")
const inboxEnqueued = sessionEvent("session-inbox-enqueued")
const inboxDelivered = sessionEvent("session-inbox-delivered")
const inboxCancelled = sessionEvent("session-inbox-cancelled")
const codeModeAdmitted = sessionEvent("session-codemode-execution-admitted")
const codeModeSettled = sessionEvent("session-codemode-execution-settled")
const codeModeDiscarded = sessionEvent("session-codemode-execution-discarded")
const backgroundStarted = sessionEvent("session-background-started")
const backgroundCompleted = sessionEvent("session-background-completed")

const input = Schema.toStandardSchemaV1(Schema.Struct({ sessionID: SessionID }))

const SESSION_DELETED = "The Session was deleted; nothing was saved."

const settle = (state: DeleteSessionState, payload: { readonly sessionID: string; readonly inboxID: string }) => {
  const pending = state.pending[payload.sessionID]
  if (pending) state.pending[payload.sessionID] = pending.filter((inboxID) => inboxID !== payload.inboxID)
}

const ended = (state: DeleteSessionState, payload: { readonly sessionID: string; readonly executionID: string }) => {
  const executions = state.executions[payload.sessionID]?.filter((executionID) => executionID !== payload.executionID)
  if (executions === undefined) return
  if (executions.length > 0) state.executions[payload.sessionID] = executions
  else delete state.executions[payload.sessionID]
}

export const deleteSession = implementCommand(specification)
  .inputSchema(input)
  .store(deleteSessionStore, { stateVersion: 2 })
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  // A deleted Session is forgotten but for its tombstone.
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
    forgetSession(
      event.payload.sessionID,
      state.active,
      state.inFlight,
      state.openCalls,
      state.pending,
      state.executions,
      state.markers,
    )
  })
  .apply(executionStarted, applyExecutionStarted)
  .apply(executionSettled, async (event, state) => {
    settleExecution(state, event.payload.sessionID)
    delete state.openCalls[event.payload.sessionID]
  })
  .apply(stepStarted, async (event, state) => {
    // A new attempt starts with a clean call table.
    delete state.openCalls[event.payload.sessionID]
    state.inFlight[event.payload.sessionID] = event.payload.assistantMessageID
  })
  .apply(stepSettled, applyStepSettled)
  .apply(toolRequested, async (event, state) => {
    const { sessionID, assistantMessageID, id, name, executed } = event.payload
    state.openCalls[sessionID] = [...(state.openCalls[sessionID] ?? []), { assistantMessageID, id, name, executed }]
  })
  .apply(toolSettled, async (event, state) => {
    const { sessionID, assistantMessageID, id } = event.payload
    const open = state.openCalls[sessionID]
    if (open)
      state.openCalls[sessionID] = open.filter(
        (call) => call.assistantMessageID !== assistantMessageID || call.id !== id,
      )
  })
  .apply(inboxEnqueued, async (event, state) => {
    const { sessionID, inboxID } = event.payload
    state.pending[sessionID] = [...(state.pending[sessionID] ?? []), inboxID]
  })
  .apply(inboxDelivered, async (event, state) => {
    settle(state, event.payload)
  })
  .apply(inboxCancelled, async (event, state) => {
    settle(state, event.payload)
  })
  .apply(codeModeAdmitted, async (event, state) => {
    const { sessionID, executionID } = event.payload
    state.executions[sessionID] = [...(state.executions[sessionID] ?? []), executionID]
  })
  .apply(codeModeSettled, async (event, state) => {
    ended(state, event.payload)
  })
  .apply(codeModeDiscarded, async (event, state) => {
    ended(state, event.payload)
  })
  // A resumed job starts again under its marker.
  .apply(backgroundStarted, async (event, state) => {
    const { sessionID, notificationID } = event.payload
    const markers = state.markers[sessionID] ?? []
    if (!markers.includes(notificationID)) state.markers[sessionID] = [...markers, notificationID]
  })
  .apply(backgroundCompleted, async (event, state) => {
    const { sessionID, notificationID } = event.payload
    const markers = state.markers[sessionID]?.filter((marker) => marker !== notificationID)
    if (markers === undefined) return
    if (markers.length > 0) state.markers[sessionID] = markers
    else delete state.markers[sessionID]
  })
  .handle(async (command, state) => {
    const { sessionID } = command
    requireLiveSession(state, sessionID)
    const step = state.inFlight[sessionID]
    // An active execution ends as a user's interruption ends it.
    const interruption = !state.active[sessionID]
      ? []
      : [
          ...(state.openCalls[sessionID] ?? []).map((call) =>
            toolSettled.create({
              sessionID,
              assistantMessageID: call.assistantMessageID,
              id: call.id,
              outcome: "failed",
              error: { type: "aborted", message: `Tool execution interrupted: ${call.name}` },
              executed: call.executed,
            }),
          ),
          ...(step === undefined
            ? []
            : [
                stepSettled.create({
                  sessionID,
                  assistantMessageID: step,
                  outcome: "failed",
                  error: { type: "aborted", message: "Step interrupted" },
                }),
              ]),
          executionSettled.create({ sessionID, outcome: "interrupted", reason: "user" }),
        ]
    return [
      ...interruption,
      ...(state.pending[sessionID] ?? []).map((inboxID) => inboxCancelled.create({ sessionID, inboxID })),
      // A Code Mode execution still admitted or running ends with its Session.
      ...(state.executions[sessionID] ?? []).map((executionID) =>
        codeModeSettled.create({ sessionID, executionID, outcome: "failed", error: SESSION_DELETED }),
      ),
      // So does every background job marker it owns: nothing would deliver its notification.
      ...(state.markers[sessionID] ?? []).map((notificationID) =>
        backgroundCompleted.create({ notificationID, sessionID }),
      ),
      sessionDeleted.create({ sessionID }),
    ]
  })
