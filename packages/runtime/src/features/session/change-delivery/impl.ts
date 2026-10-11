import { SessionID } from "@ocpp/schema/session-id"
import { SessionInbox } from "@ocpp/schema/session-inbox"
import { SessionMessage } from "@ocpp/schema/session-message"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted, and each inbox item's Session, delivery and whether it is still
// pending. Duplicated from the other inbox Slices on purpose.
export type ChangeDeliveryState = {
  sessions: Record<string, "live" | "deleted">
  items: Record<string, { sessionID: string; delivery: "steer" | "queue"; pending: boolean }>
}

export const changeDeliveryStore = Context.Service<
  SliceStoreService<ChangeDeliveryState, ChangeDeliveryState, unknown>
>("@ocpp/runtime/ChangeDeliveryStore")

export const createChangeDeliveryState = (): ChangeDeliveryState => ({
  sessions: {},
  items: {},
})

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const inboxEnqueued = sessionEvent("session-inbox-enqueued")
const inboxDelivered = sessionEvent("session-inbox-delivered")
const inboxCancelled = sessionEvent("session-inbox-cancelled")
const deliveryChanged = sessionEvent("session-inbox-delivery-changed")

const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    sessionID: SessionID,
    inboxID: SessionMessage.ID,
    delivery: SessionInbox.Delivery,
  }),
)

const settle = (state: ChangeDeliveryState, inboxID: string) => {
  const item = state.items[inboxID]
  if (item) item.pending = false
}

// Steering a queued item or queueing a steered one (OC++ Session.steer and
// Session.queue). Only pending input changes delivery.
export const changeDelivery = implementCommand(specification)
  .inputSchema(input)
  .store(changeDeliveryStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
  })
  .apply(inboxEnqueued, async (event, state) => {
    const { sessionID, inboxID, item } = event.payload
    state.items[inboxID] ??= {
      sessionID,
      delivery: item.delivery,
      pending: true,
    }
  })
  .apply(inboxDelivered, async (event, state) => {
    settle(state, event.payload.inboxID)
  })
  .apply(inboxCancelled, async (event, state) => {
    settle(state, event.payload.inboxID)
  })
  .apply(deliveryChanged, async (event, state) => {
    const item = state.items[event.payload.inboxID]
    if (item) item.delivery = event.payload.delivery
  })
  .handle(async (command, state) => {
    if (!state.sessions[command.sessionID]) throw new CommandRejection("session-not-found", "Session not found")
    if (state.sessions[command.sessionID] === "deleted")
      throw new CommandRejection("session-deleted", "Session deleted")
    const item = state.items[command.inboxID]
    if (item?.sessionID !== command.sessionID)
      throw new CommandRejection("inbox-item-not-found", "Inbox item not found")
    if (!item.pending) throw new CommandRejection("inbox-item-not-pending", "Inbox item not pending")
    if (item.delivery === command.delivery)
      throw new CommandRejection("inbox-delivery-unchanged", `Inbox item already ${command.delivery}`)
    return [
      deliveryChanged.create({
        sessionID: command.sessionID,
        inboxID: command.inboxID,
        delivery: command.delivery,
      }),
    ]
  })
