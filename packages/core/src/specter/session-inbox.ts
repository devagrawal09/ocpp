export * as SpecterSessionInbox from "./session-inbox.js"

import { Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { SessionInbox } from "../session/inbox.js"
import { SessionMessage } from "../session/message.js"
import { SessionSchema } from "../session/schema.js"
import { rejection, SpecterSessionRuntime } from "./session-runtime.js"

const encodeUser = Schema.encodeSync(SessionInbox.UserPayload)
const encodeSynthetic = Schema.encodeSync(SessionInbox.SyntheticPayload)

const unsupported = (what: string) =>
  Effect.die(new Error(`${what} is not supported when the Specter runtime runs Sessions yet`))

/**
 * `SessionInbox.Service` when the embedded Specter runtime runs Sessions. Admission and cancellation
 * are runtime Commands. Reads stay on OC++'s inbox projection, which the runtime's events build
 * through the Bus, so `list` and the idempotent `reconcile` are OC++'s own.
 */
export const layer = Layer.effect(
  SessionInbox.Service,
  Effect.gen(function* () {
    const local = yield* SessionInbox.make()
    const specter = yield* SpecterSessionRuntime.Service
    const db = (yield* Database.Service).db

    const admit = Effect.fn("SpecterSessionInbox.admit")(function* <Type extends SessionInbox.Item["type"]>(request: {
      readonly id: SessionMessage.ID
      readonly sessionID: SessionSchema.ID
      readonly item: SessionInbox.Item & { readonly type: Type }
      readonly replaces?: ReadonlyArray<SessionMessage.ID>
    }) {
      const existing = yield* local.reconcile({ ...request, type: request.item.type, delivery: request.item.delivery })
      if (existing !== undefined) return existing
      const item: SessionInbox.Item = request.item
      if (item.type === "move") return yield* unsupported("A move inbox item")
      yield* specter.register(request.sessionID)
      const replaces =
        request.replaces === undefined || request.replaces.length === 0 ? {} : { replaces: request.replaces }
      const recorded = yield* specter.runtime
        .command({
          type: "enqueueInput",
          payload:
            item.type === "user"
              ? {
                  sessionID: request.sessionID,
                  inboxID: request.id,
                  type: "user",
                  payload: encodeUser(item.payload),
                  delivery: item.delivery,
                  ...replaces,
                }
              : item.type === "synthetic"
                ? {
                    sessionID: request.sessionID,
                    inboxID: request.id,
                    type: "synthetic",
                    payload: encodeSynthetic(item.payload),
                    delivery: item.delivery,
                    ...replaces,
                  }
                : {
                    sessionID: request.sessionID,
                    inboxID: request.id,
                    type: "compaction",
                    payload: {},
                    delivery: item.delivery,
                  },
        })
        .pipe(
          Effect.map((execution) => execution.reactions),
          // A rejected admission (already admitted, or reused across Sessions or types) is decided
          // below from what OC++ projected for this ID.
          Effect.catch((error) => (rejection(error) === undefined ? Effect.die(error) : Effect.succeed(Effect.void))),
        )
      // The runtime starts execution from its own Reaction; settle it before returning, so a caller
      // that waits for the Session sees the execution this input started.
      yield* recorded.pipe(Effect.orDie)
      const admitted = yield* SessionInbox.find(db, request.id)
      if (admitted?.sessionID !== request.sessionID || admitted.type !== request.item.type)
        return yield* new SessionInbox.LifecycleConflict({ id: request.id })
      return admitted as Extract<SessionInbox.Info, { readonly type: Type }>
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
      ...local,
      // Same contract as OC++'s admit; its generic signature does not unify with this one.
      admit: admit as SessionInbox.Interface["admit"],
      cancel,
      // As OC++'s inbox: a pending compaction absorbs a second request.
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
        const pending = (yield* local.list(input.sessionID)).find((item) => item.type === "compaction")
        if (pending) return pending
        return yield* admit({
          id: input.id,
          sessionID: input.sessionID,
          item: { type: "compaction", payload: {}, delivery: input.delivery },
        })
      }),
      steer: changeDelivery(SessionInbox.Delivery.make("steer")),
      queue: changeDelivery(SessionInbox.Delivery.make("queue")),
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionInbox.Service,
  layer,
  deps: [Database.node, Bus.node, SpecterSessionRuntime.node],
})
