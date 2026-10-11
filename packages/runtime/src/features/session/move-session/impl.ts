import { SessionEvent } from "@ocpp/schema/session-event"
import type { SessionMessage } from "@ocpp/schema/session-message"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted, and the move items waiting in each Session's inbox, in admission
// order. Duplicated from the inbox Slices on purpose.
export type MoveSessionState = {
  sessions: Record<string, "live" | "deleted">
  moves: Record<string, SessionMessage.ID[]>
}

export const moveSessionStore = Context.Service<SliceStoreService<MoveSessionState, MoveSessionState, unknown>>(
  "@ocpp/runtime/MoveSessionStore",
)

export const createMoveSessionState = (): MoveSessionState => ({ sessions: {}, moves: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const sessionMoved = sessionEvent("session-moved")
const inboxEnqueued = sessionEvent("session-inbox-enqueued")
const inboxDelivered = sessionEvent("session-inbox-delivered")
const inboxCancelled = sessionEvent("session-inbox-cancelled")

// The destination, as session-moved records it.
const input = Schema.toStandardSchemaV1(SessionEvent.Moved.data)

const settle = (state: MoveSessionState, payload: { readonly sessionID: string; readonly inboxID: string }) => {
  const moves = state.moves[payload.sessionID]
  if (moves) state.moves[payload.sessionID] = moves.filter((inboxID) => inboxID !== payload.inboxID)
}

export const moveSession = implementCommand(specification)
  .inputSchema(input)
  .store(moveSessionStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
  })
  .apply(inboxEnqueued, async (event, state) => {
    const { sessionID, inboxID, item } = event.payload
    if (item.type === "move") state.moves[sessionID] = [...(state.moves[sessionID] ?? []), inboxID]
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
    return [
      ...(state.moves[sessionID] ?? []).map((inboxID) => inboxCancelled.create({ sessionID, inboxID })),
      sessionMoved.create(command),
    ]
  })
