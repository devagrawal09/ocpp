import { Catalog } from "@ocpp/core/catalog"
import { ProviderNotFoundError, ServiceUnavailableError } from "@ocpp/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { response } from "../location"
import { pluginReadiness } from "./plugin-readiness"

const flushPlugins = pluginReadiness(
  () =>
    new ServiceUnavailableError({
      message: "Provider catalog initialization timed out",
      service: "provider.catalog",
    }),
)

export const ProviderHandler = HttpApiBuilder.group(Api, "server.provider", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "provider.list",
        Effect.fn(function* () {
          yield* flushPlugins
          const catalog = yield* Catalog.Service
          return yield* response(catalog.provider.available())
        }),
      )
      .handle(
        "provider.get",
        Effect.fn(function* (ctx) {
          yield* flushPlugins
          const catalog = yield* Catalog.Service
          const provider = yield* catalog.provider.get(ctx.params.providerID)
          if (!provider)
            return yield* new ProviderNotFoundError({
              providerID: ctx.params.providerID,
              message: `Provider not found: ${ctx.params.providerID}`,
            })
          return yield* response(Effect.succeed(provider))
        }),
      )
  }),
)
