import { SessionEvent } from "@ocpp/schema/session-event"
import type { SessionMessage } from "@ocpp/schema/session-message"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applySessionCreated,
  applySessionDeleted,
  forgetSession,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or deleted,
// and the move items waiting in each Session's inbox, in admission order. Its
// Session lifecycle is the shared fold in session/lifecycle.ts; the rest is
// duplicated from the inbox Slices on purpose.
export type MoveSessionState = {
  sessions: Record<string, "live" | "deleted">
  moves: Record<string, SessionMessage.ID[]>
}

export const moveSessionStore = Context.Service<SliceStoreService<MoveSessionState, MoveSessionState, unknown>>(
  "@ocpp/runtime/MoveSessionStore",
)

export const createMoveSessionState = (): MoveSessionState => ({ sessions: {}, moves: {} })

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
  .store(moveSessionStore, { stateVersion: 2 })
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  // A deleted Session is forgotten but for its tombstone.
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
    forgetSession(event.payload.sessionID, state.moves)
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
    requireLiveSession(state, sessionID)
    return [
      ...(state.moves[sessionID] ?? []).map((inboxID) => inboxCancelled.create({ sessionID, inboxID })),
      sessionMoved.create(command),
    ]
  })
