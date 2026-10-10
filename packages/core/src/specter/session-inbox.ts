export * as SpecterSessionInbox from "./session-inbox.js"

import { Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { Database } from "../database/database.js"
import { SessionInbox } from "../session/inbox.js"
import { SessionMessage } from "../session/message.js"
import { SessionSchema } from "../session/schema.js"
import { rejection, SpecterSessionRuntime } from "./session-runtime.js"

const encodeUser = Schema.encodeSync(SessionInbox.UserPayload)
const encodeSynthetic = Schema.encodeSync(SessionInbox.SyntheticPayload)
const encodeMove = Schema.encodeSync(SessionInbox.MovePayload)
const decodeInfo = Schema.decodeUnknownSync(SessionInbox.Info)

type Admission<Type extends SessionInbox.Item["type"]> = {
  readonly id: SessionMessage.ID
  readonly sessionID: SessionSchema.ID
  readonly item: SessionInbox.Item & { readonly type: Type }
  readonly coalesce?: { readonly key: string; readonly replaces: ReadonlyArray<SessionMessage.ID> }
  readonly resume?: boolean
}

/**
 * The Session inbox: the embedded Specter runtime's. Admission, cancellation and delivery changes are
 * runtime Commands, and the runtime decides each, retried admissions included. Reads are OC++'s inbox
 * projection, which the runtime's facts build in the transaction that records them.
 */
export const layer = Layer.effect(
  SessionInbox.Service,
  Effect.gen(function* () {
    const specter = yield* SpecterSessionRuntime.Service
    const db = (yield* Database.Service).db

    const admitted = Effect.fn("SpecterSessionInbox.admitted")(function* <
      Type extends SessionInbox.Item["type"],
    >(request: {
      readonly id: SessionMessage.ID
      readonly sessionID: SessionSchema.ID
      readonly type: Type
      readonly delivery: SessionInbox.Delivery
    }) {
      const existing =
        (yield* SessionInbox.find(db, request.id)) ??
        (yield* SessionInbox.delivered(db, request.sessionID, request.id, request.delivery))
      if (existing === undefined) return undefined
      if (existing.type === "compaction" || existing.sessionID !== request.sessionID || existing.type !== request.type)
        return yield* new SessionInbox.LifecycleConflict({ id: request.id })
      return existing as Extract<SessionInbox.Info, { readonly type: Type }>
    })

    // Records an item, or answers why the runtime refused it.
    const enqueue = Effect.fn("SpecterSessionInbox.enqueue")(function* <Type extends SessionInbox.Item["type"]>(
      request: Admission<Type>,
    ) {
      const item: SessionInbox.Item = request.item
      yield* specter.register(request.sessionID)
      const base = {
        sessionID: request.sessionID,
        inboxID: request.id,
        delivery: item.delivery,
        // The runtime wakes on admission unless told the input waits.
        ...(request.resume === false ? { resume: false } : {}),
      }
      const recorded = yield* specter.runtime
        .command({
          type: "enqueueInput",
          payload:
            item.type === "user"
              ? { ...base, type: "user", payload: encodeUser(item.payload) }
              : item.type === "synthetic"
                ? {
                    ...base,
                    type: "synthetic",
                    payload: encodeSynthetic(item.payload),
                    ...(request.coalesce === undefined ? {} : { coalesce: request.coalesce }),
                  }
                : item.type === "compaction"
                  ? { ...base, type: "compaction", payload: {} }
                  : { ...base, type: "move", payload: encodeMove(item.payload) },
        })
        .pipe(
          Effect.map((execution) => ({ execution })),
          Effect.catch((error) => {
            const reason = rejection(error)
            return reason === undefined ? Effect.die(error) : Effect.succeed({ reason })
          }),
          // The inbox projection refused the item: its ID names a message already.
          Effect.catchDefect((defect) =>
            defect instanceof SessionInbox.LifecycleConflict ? Effect.fail(defect) : Effect.die(defect),
          ),
        )
      if ("reason" in recorded) return recorded
      // The runtime starts execution from its own Reaction; settle it before returning, so a caller that
      // waits for the Session sees the execution this input started.
      yield* recorded.execution.reactions.pipe(Effect.orDie)
      // The item as the runtime admitted it: the runtime may deliver it before a projection read.
      const enqueued = recorded.execution.events.find((event) => event.type === "session-inbox-enqueued")
      if (!enqueued) return yield* Effect.die(new Error(`Admission of ${request.id} recorded no input`))
      return {
        admitted: decodeInfo({
          id: request.id,
          sessionID: request.sessionID,
          timeCreated: Date.parse(enqueued.recordedAt),
          ...(enqueued.payload as { readonly item: object }).item,
        }) as Extract<SessionInbox.Info, { readonly type: Type }>,
      }
    })

    const admit = Effect.fn("SpecterSessionInbox.admit")(function* <Type extends SessionInbox.Item["type"]>(
      request: Admission<Type>,
    ) {
      const recorded = yield* enqueue(request)
      if ("admitted" in recorded) return recorded.admitted
      // A retried admission: the first one wins.
      const first =
        recorded.reason === "Inbox item already admitted"
          ? yield* admitted({ ...request, type: request.item.type, delivery: request.item.delivery })
          : undefined
      if (first) return first
      // Reused across Sessions or types, cancelled, or (coalescing) the replaced items changed.
      return yield* new SessionInbox.LifecycleConflict({ id: request.id })
    })

    // Steering a queued item or queueing a steered one; a rejection means it is no longer pending that way.
    const changeDelivery = (delivery: SessionInbox.Delivery) =>
      Effect.fn("SpecterSessionInbox.changeDelivery")(function* (input: {
        readonly id: SessionMessage.ID
        readonly sessionID: SessionSchema.ID
      }) {
        yield* specter.register(input.sessionID)
        yield* specter.runtime
          .command({
            type: "changeDelivery",
            payload: { sessionID: input.sessionID, inboxID: input.id, delivery },
          })
          .pipe(
            Effect.catch((error) =>
              rejection(error) === undefined
                ? Effect.die(error)
                : Effect.fail(new SessionInbox.LifecycleConflict({ id: input.id })),
            ),
          )
      })

    const cancel = Effect.fn("SpecterSessionInbox.cancel")(function* (input: {
      readonly id: SessionMessage.ID
      readonly sessionID: SessionSchema.ID
    }) {
      yield* specter.register(input.sessionID)
      yield* specter.runtime
        .command({ type: "cancelInboxItem", payload: { sessionID: input.sessionID, inboxID: input.id } })
        .pipe(
          Effect.catch((error) =>
            rejection(error) === undefined
              ? Effect.die(error)
              : Effect.fail(new SessionInbox.LifecycleConflict({ id: input.id })),
          ),
        )
    })

    return SessionInbox.Service.of({
      list: (sessionID) => SessionInbox.list(db, sessionID),
      // Same contract as the interface's; their generic signatures do not unify.
      admitted: admitted as SessionInbox.Interface["admitted"],
      admit: admit as SessionInbox.Interface["admit"],
      cancel,
      admitCompaction: Effect.fn("SpecterSessionInbox.admitCompaction")(function* (input: {
        readonly id: SessionMessage.ID
        readonly sessionID: SessionSchema.ID
        readonly delivery: SessionInbox.Delivery
      }) {
        const exact = yield* SessionInbox.find(db, input.id)
        if (exact) {
          if (exact.type === "compaction" && exact.sessionID === input.sessionID) return exact
          return yield* new SessionInbox.LifecycleConflict({ id: input.id })
        }
        const recorded = yield* enqueue({
          id: input.id,
          sessionID: input.sessionID,
          item: { type: "compaction", payload: {}, delivery: input.delivery },
        })
        if ("admitted" in recorded) return recorded.admitted
        if (recorded.reason !== "Compaction already pending")
          return yield* new SessionInbox.LifecycleConflict({ id: input.id })
        // The runtime refused it for the pending one, which absorbs this request.
        const pending = (yield* SessionInbox.list(db, input.sessionID)).find(
          (item): item is SessionInbox.Compaction => item.type === "compaction",
        )
        if (pending) return pending
        // Delivered meanwhile: ask again.
        return yield* new SessionInbox.LifecycleConflict({ id: input.id })
      }),
      steer: changeDelivery(SessionInbox.Delivery.make("steer")),
      queue: changeDelivery(SessionInbox.Delivery.make("queue")),
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionInbox.Service,
  layer,
  deps: [Database.node, SpecterSessionRuntime.node],
})
