export * as SpecterSessionModel from "./session-model.js"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { hostModel, type Model } from "@specter/agent-runtime"
import { Catalog } from "../catalog.js"
import { llmClient } from "../effect/app-node-platform.js"
import { LocationServiceMap } from "../location-service-map.js"
import { PluginSupervisor } from "../plugin/supervisor.js"
import { SessionRunnerModel } from "../session/runner/model.js"
import { SessionSchema } from "../session/schema.js"
import { SessionStore } from "../session/store.js"

/**
 * The model the embedded Specter runtime calls. Each Session's language model is resolved the way
 * OC++'s runner resolves it: the Session's selected model, or its Location's default, from the
 * catalog its plugins populated.
 */
export class Service extends Context.Service<Service, Model["Service"]>()("@ocpp/SpecterSessionModel") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    return yield* hostModel((sessionID) =>
      Effect.gen(function* () {
        const session = yield* store.get(SessionSchema.ID.make(sessionID))
        if (!session)
          return yield* Effect.fail({
            type: "session.not-found",
            message: `Session not found: ${sessionID}`,
            retryable: false,
          })
        const resolved = yield* Effect.gen(function* () {
          yield* (yield* PluginSupervisor.Service).flush
          const catalog = yield* Catalog.Service
          const models = yield* SessionRunnerModel.Service
          return yield* models.resolve(session, catalog.model.available)
        }).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.mapError((error) => ({ type: `model.${error._tag}`, message: error.message, retryable: false })),
        )
        return { model: resolved.model, ref: { id: resolved.ref.id, providerID: resolved.ref.providerID } }
      }),
    )
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node, llmClient],
})
