import { SessionID } from "@ocpp/schema/session-id"
import type { SessionInbox } from "@ocpp/schema/session-inbox"
import { SessionMessage } from "@ocpp/schema/session-message"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applyExecutionSettled,
  applyExecutionStarted,
  applySessionCreated,
  applySessionDeleted,
  executionSettled,
  executionStarted,
  forgetOwned,
  forgetSession,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: known Sessions, active executions, and each inbox
// item's status. Its Session lifecycle is the shared fold in
// session/lifecycle.ts; the rest is duplicated from cancel-inbox-item on
// purpose.
export type DeliverInboxItemState = {
  sessions: Record<string, "live" | "deleted">
  active: Record<string, true>
  items: Record<
    string,
    {
      sessionID: string
      status: "pending" | "delivered" | "cancelled"
      // A move item's destination.
      move?: SessionInbox.MovePayload
    }
  >
}

export const deliverInboxItemStore = Context.Service<
  SliceStoreService<DeliverInboxItemState, DeliverInboxItemState, unknown>
>("@ocpp/runtime/DeliverInboxItemStore")

export const createDeliverInboxItemState = (): DeliverInboxItemState => ({
  sessions: {},
  active: {},
  items: {},
})

const inboxEnqueued = sessionEvent("session-inbox-enqueued")
const inboxDelivered = sessionEvent("session-inbox-delivered")
const inboxCancelled = sessionEvent("session-inbox-cancelled")
const sessionMoved = sessionEvent("session-moved")

const input = Schema.toStandardSchemaV1(Schema.Struct({ sessionID: SessionID, inboxID: SessionMessage.ID }))

export const deliverInboxItem = implementCommand(specification)
  .inputSchema(input)
  .store(deliverInboxItemStore, { stateVersion: 2 })
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  // A deleted Session is forgotten but for its tombstone.
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
    forgetSession(event.payload.sessionID, state.active)
    forgetOwned(event.payload.sessionID, state.items)
  })
  .apply(inboxEnqueued, async (event, state) => {
    const { sessionID, inboxID, item } = event.payload
    state.items[inboxID] ??= {
      sessionID,
      status: "pending",
      ...(item.type === "move" ? { move: item.payload } : {}),
    }
  })
  .apply(executionStarted, applyExecutionStarted)
  .apply(executionSettled, applyExecutionSettled)
  .apply(inboxDelivered, async (event, state) => {
    const item = state.items[event.payload.inboxID]
    if (item) item.status = "delivered"
  })
  .apply(inboxCancelled, async (event, state) => {
    const item = state.items[event.payload.inboxID]
    if (item) item.status = "cancelled"
  })
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    // Delivery is runner-owned: it cannot happen without an active execution.
    if (!state.active[command.sessionID]) throw new CommandRejection("execution-not-active", "Execution not active")

    const item = state.items[command.inboxID]
    if (!item || item.sessionID !== command.sessionID)
      throw new CommandRejection("inbox-item-not-found", "Inbox item not found")
    if (item.status === "delivered")
      throw new CommandRejection("inbox-item-already-delivered", "Inbox item already delivered")
    if (item.status === "cancelled")
      throw new CommandRejection("inbox-item-already-cancelled", "Inbox item already cancelled")
    const delivered = inboxDelivered.create({
      sessionID: command.sessionID,
      inboxID: command.inboxID,
    })
    // Delivering a move moves the Session in the same commit.
    if (item.move) return [delivered, sessionMoved.create({ sessionID: command.sessionID, ...item.move })]
    return [delivered]
  })
