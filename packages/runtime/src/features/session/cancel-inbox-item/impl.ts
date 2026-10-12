import { SessionID } from "@ocpp/schema/session-id"
import { SessionMessage } from "@ocpp/schema/session-message"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applySessionCreated,
  applySessionDeleted,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: known Sessions and each inbox item's status. Its
// Session lifecycle is the shared fold in session/lifecycle.ts; the rest is
// duplicated from enqueue-input on purpose.
export type CancelInboxItemState = {
  sessions: Record<string, "live" | "deleted">
  items: Record<string, { sessionID: string; status: "pending" | "delivered" | "cancelled" }>
}

export const cancelInboxItemStore = Context.Service<
  SliceStoreService<CancelInboxItemState, CancelInboxItemState, unknown>
>("@ocpp/runtime/CancelInboxItemStore")

export const createCancelInboxItemState = (): CancelInboxItemState => ({
  sessions: {},
  items: {},
})

const inboxEnqueued = sessionEvent("session-inbox-enqueued")
const inboxDelivered = sessionEvent("session-inbox-delivered")
const inboxCancelled = sessionEvent("session-inbox-cancelled")

const input = Schema.toStandardSchemaV1(Schema.Struct({ sessionID: SessionID, inboxID: SessionMessage.ID }))

export const cancelInboxItem = implementCommand(specification)
  .inputSchema(input)
  .store(cancelInboxItemStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, applySessionDeleted)
  .apply(inboxEnqueued, async (event, state) => {
    const { sessionID, inboxID } = event.payload
    state.items[inboxID] ??= { sessionID, status: "pending" }
  })
  .apply(inboxDelivered, async (event, state) => {
    const { inboxID } = event.payload
    const item = state.items[inboxID]
    if (item) item.status = "delivered"
  })
  .apply(inboxCancelled, async (event, state) => {
    const { inboxID } = event.payload
    const item = state.items[inboxID]
    if (item) item.status = "cancelled"
  })
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)

    const item = state.items[command.inboxID]
    if (!item || item.sessionID !== command.sessionID)
      throw new CommandRejection("inbox-item-not-found", "Inbox item not found")
    if (item.status === "delivered")
      throw new CommandRejection("inbox-item-already-delivered", "Inbox item already delivered")
    if (item.status === "cancelled")
      throw new CommandRejection("inbox-item-already-cancelled", "Inbox item already cancelled")
    return [
      inboxCancelled.create({
        sessionID: command.sessionID,
        inboxID: command.inboxID,
      }),
    ]
  })
