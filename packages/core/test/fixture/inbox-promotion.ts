import type { Bus } from "@ocpp/core/bus"
import type { Database } from "@ocpp/core/database/database"
import { SessionEvent } from "@ocpp/core/session/event"
import { SessionInbox } from "@ocpp/core/session/inbox"
import type { SessionSchema } from "@ocpp/core/session/schema"
import { Effect } from "effect"

/**
 * OC++'s former inbox promotion, kept for tests that deliver pending input without the Specter runtime
 * (which delivers it in production). Steers go first, up to a control item; the "input" scope may fall
 * through to one queued item and the steers that arrived behind it.
 */
type DatabaseService = Database.Interface["db"]

const beforeControl = (items: ReadonlyArray<SessionInbox.Info>) => {
  const control = items.findIndex((item) => item.type === "compaction" || item.type === "move")
  return control === -1 ? items : items.slice(0, control)
}

const deliver = (bus: Bus.Interface, sessionID: SessionSchema.ID, items: ReadonlyArray<SessionInbox.Info>) =>
  Effect.forEach(items, (item) => bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: item.id }), {
    discard: true,
  }).pipe(Effect.as(items))

const steers = (db: DatabaseService, sessionID: SessionSchema.ID) =>
  SessionInbox.list(db, sessionID).pipe(Effect.map((items) => items.filter((item) => item.delivery === "steer")))

/** Promotes pending input into visible messages and returns the promoted items in delivery order. */
export const promoteItems = (
  db: DatabaseService,
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
  scope: SessionInbox.Promotable,
) =>
  SessionInbox.serialized(
    sessionID,
    Effect.gen(function* () {
      const pending = yield* steers(db, sessionID)
      if (pending.length > 0 || scope === "steer") return yield* deliver(bus, sessionID, beforeControl(pending))
      const queued = (yield* SessionInbox.list(db, sessionID)).find((item) => item.delivery === "queue")
      // A control item is delivered by its own path, never as input.
      if (!queued || queued.type === "compaction" || queued.type === "move") return []
      const promoted = yield* deliver(bus, sessionID, [queued])
      return [...promoted, ...(yield* deliver(bus, sessionID, beforeControl(yield* steers(db, sessionID))))]
    }),
  )

/** Promotes pending input into visible messages and returns the promoted count. */
export const promote = (
  db: DatabaseService,
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
  scope: SessionInbox.Promotable,
) => promoteItems(db, bus, sessionID, scope).pipe(Effect.map((items) => items.length))

/** The item a promotion at this scope would take first. */
export const nextPromotable = (db: DatabaseService, sessionID: SessionSchema.ID, scope: SessionInbox.Promotable) =>
  SessionInbox.list(db, sessionID).pipe(
    Effect.map(
      (items) =>
        items.find((item) => item.delivery === "steer") ??
        (scope === "input" ? items.find((item) => item.delivery === "queue") : undefined),
    ),
  )
