import { SessionID } from "@ocpp/schema/session-id"
import type { SessionMessage } from "@ocpp/schema/session-message"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted; each Session's active execution, its in-flight step and the open
// tool calls of that step (as interrupt-execution keeps them); and its
// pending inbox items in admission order. Duplicated on purpose.
export type DeleteSessionState = {
  sessions: Record<string, "live" | "deleted">
  active: Record<string, true>
  inFlight: Record<string, SessionMessage.ID>
  openCalls: Record<string, OpenCall[]>
  pending: Record<string, SessionMessage.ID[]>
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
})

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const executionStarted = sessionEvent("session-execution-started")
const executionSettled = sessionEvent("session-execution-settled")
const stepStarted = sessionEvent("session-step-started")
const stepSettled = sessionEvent("session-step-settled")
const toolRequested = sessionEvent("session-tool-requested")
const toolSettled = sessionEvent("session-tool-settled")
const inboxEnqueued = sessionEvent("session-inbox-enqueued")
const inboxDelivered = sessionEvent("session-inbox-delivered")
const inboxCancelled = sessionEvent("session-inbox-cancelled")

const input = Schema.toStandardSchemaV1(Schema.Struct({ sessionID: SessionID }))

const settle = (state: DeleteSessionState, payload: { readonly sessionID: string; readonly inboxID: string }) => {
  const pending = state.pending[payload.sessionID]
  if (pending) state.pending[payload.sessionID] = pending.filter((inboxID) => inboxID !== payload.inboxID)
}

export const deleteSession = implementCommand(specification)
  .inputSchema(input)
  .store(deleteSessionStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
  })
  .apply(executionStarted, async (event, state) => {
    state.active[event.payload.sessionID] = true
  })
  .apply(executionSettled, async (event, state) => {
    const { sessionID } = event.payload
    delete state.active[sessionID]
    delete state.inFlight[sessionID]
    delete state.openCalls[sessionID]
  })
  .apply(stepStarted, async (event, state) => {
    // A new attempt starts with a clean call table.
    delete state.openCalls[event.payload.sessionID]
    state.inFlight[event.payload.sessionID] = event.payload.assistantMessageID
  })
  .apply(stepSettled, async (event, state) => {
    const { sessionID, assistantMessageID } = event.payload
    if (state.inFlight[sessionID] === assistantMessageID) delete state.inFlight[sessionID]
  })
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
  .handle(async (command, state) => {
    const { sessionID } = command
    if (!state.sessions[sessionID]) throw new Error("Session not found")
    if (state.sessions[sessionID] === "deleted") throw new Error("Session deleted")
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
      sessionDeleted.create({ sessionID }),
    ]
  })
