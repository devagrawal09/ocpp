import { SessionID } from "@ocpp/schema/session-id"
import { SessionInbox } from "@ocpp/schema/session-inbox"
import { SessionMessage } from "@ocpp/schema/session-message"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Slice state is a rebuildable projection of the Event Log: which Sessions
// exist, which Session/type each inbox ID was admitted under, whether it is
// still pending, and the coalescing key a synthetic item was admitted under.
// It is a duplicate of the projection in cancel-inbox-item on purpose.
export type EnqueueInputState = {
  sessions: Record<string, true>
  items: Record<string, { sessionID: string; type: string; pending: boolean; coalesce?: string }>
}

export const enqueueInputStore = Context.Service<SliceStoreService<EnqueueInputState, EnqueueInputState, unknown>>(
  "@ocpp/session-runtime/EnqueueInputStore",
)

export const createEnqueueInputState = (): EnqueueInputState => ({
  sessions: {},
  items: {},
})

const sessionCreated = sessionEvent("session-created")
const inboxEnqueued = sessionEvent("session-inbox-enqueued")
const inboxDelivered = sessionEvent("session-inbox-delivered")
const inboxCancelled = sessionEvent("session-inbox-cancelled")
const inboxHeld = sessionEvent("session-inbox-held")
const revertCommitted = sessionEvent("session-revert-committed")

const base = {
  sessionID: SessionID,
  inboxID: SessionMessage.ID,
  delivery: Schema.optional(SessionInbox.Delivery),
  // false: the input waits for the next wake instead of waking the Session.
  resume: Schema.optional(Schema.Boolean),
}

// The flat Command input, discriminated on `type` so the payload reaches the
// event as OC++'s own Session.Inbox.Item without a cast.
const commandSchema = Schema.Union([
  Schema.Struct({
    ...base,
    type: Schema.Literal("user"),
    payload: SessionInbox.UserPayload,
  }),
  Schema.Struct({
    ...base,
    type: Schema.Literal("synthetic"),
    payload: SessionInbox.SyntheticPayload,
    // Repeated notices from one source reach the model once: this input
    // replaces the pending synthetic items admitted under the same key, which
    // are cancelled in the same commit, and carries the key in its metadata.
    // `replaces` names exactly those items: the caller merged their payloads
    // into this one, so a set that changed meanwhile is refused.
    coalesce: Schema.optional(
      Schema.Struct({
        key: Schema.String,
        replaces: Schema.Array(SessionMessage.ID),
      }),
    ),
  }),
  // Control items: a manual compaction, and a move to another Location.
  Schema.Struct({
    ...base,
    type: Schema.Literal("compaction"),
    payload: SessionInbox.CompactionPayload,
  }),
  Schema.Struct({
    ...base,
    type: Schema.Literal("move"),
    payload: SessionInbox.MovePayload,
  }),
])
type Command = typeof commandSchema.Type
const input = Schema.toStandardSchemaV1(commandSchema)

// The admitted item as OC++'s Session.Inbox.Item, with steer as the default
// delivery.
const item = (command: Command) => {
  const delivery = command.delivery ?? "steer"
  switch (command.type) {
    case "user":
      return { type: "user" as const, payload: command.payload, delivery }
    case "synthetic":
      return {
        type: "synthetic" as const,
        payload:
          command.coalesce === undefined
            ? command.payload
            : {
                ...command.payload,
                metadata: { ...command.payload.metadata, coalesce: command.coalesce.key },
              },
        delivery,
      }
    case "compaction":
      return {
        type: "compaction" as const,
        payload: command.payload,
        delivery,
      }
    case "move":
      return { type: "move" as const, payload: command.payload, delivery }
  }
}

export const enqueueInput = implementCommand(specification)
  .inputSchema(input)
  .store(enqueueInputStore)
  .apply(sessionCreated, async (event, state) => {
    const { sessionID } = event.payload
    state.sessions[sessionID] = true
  })
  .apply(inboxEnqueued, async (event, state) => {
    const { sessionID, inboxID, item } = event.payload
    const coalesce = item.type === "synthetic" ? item.payload.metadata?.coalesce : undefined
    state.items[inboxID] ??= {
      sessionID,
      type: item.type,
      pending: true,
      ...(typeof coalesce === "string" ? { coalesce } : {}),
    }
  })
  .apply(inboxDelivered, async (event, state) => {
    const item = state.items[event.payload.inboxID]
    if (item) item.pending = false
  })
  .apply(inboxCancelled, async (event, state) => {
    const item = state.items[event.payload.inboxID]
    if (item) item.pending = false
  })
  // Deliberately a no-op: a committed revert does not affect admission; the
  // scenario puts it in Given to prove admission works normally afterwards.
  .apply(revertCommitted, async () => {})
  .handle(async (command, state) => {
    if (!state.sessions[command.sessionID]) throw new Error("Session not found")

    const existing = state.items[command.inboxID]
    if (existing) {
      if (existing.sessionID !== command.sessionID) throw new Error("Inbox item belongs to a different session")
      if (existing.type !== command.type) throw new Error("Inbox item type does not match existing item")
      throw new Error("Inbox item already admitted")
    }

    // A pending manual compaction absorbs another request for one: the caller
    // takes the pending one.
    if (
      command.type === "compaction" &&
      Object.values(state.items).some(
        (item) => item.sessionID === command.sessionID && item.type === "compaction" && item.pending,
      )
    )
      throw new Error("Compaction already pending")

    // The replaced items must be exactly the ones pending under the key:
    // one delivered or cancelled meanwhile would be dropped, and one coalesced
    // meanwhile would stay beside this one. The caller reads them again.
    const coalesce = command.type === "synthetic" ? command.coalesce : undefined
    const replaced = [...new Set(coalesce?.replaces ?? [])]
    if (coalesce) {
      const pending = new Set(
        Object.entries(state.items).flatMap(([inboxID, item]) =>
          item.sessionID === command.sessionID && item.pending && item.coalesce === coalesce.key ? [inboxID] : [],
        ),
      )
      if (pending.size !== replaced.length || replaced.some((inboxID) => !pending.has(inboxID)))
        throw new Error("Coalesced input changed")
    }

    // The wake Reaction reads `resume: false` from the held fact; OC++'s
    // enqueued fact has no field for it.
    const ref = { sessionID: command.sessionID, inboxID: command.inboxID }
    return [
      ...replaced.map((inboxID) => inboxCancelled.create({ sessionID: command.sessionID, inboxID })),
      inboxEnqueued.create({ ...ref, item: item(command) }),
      ...(command.resume === false ? [inboxHeld.create(ref)] : []),
    ]
  })
