import { Catalog } from "@ocpp/core/catalog"
import { ExternalAgentDrivers } from "@ocpp/core/external-agent/drivers"
import { ServiceUnavailableError } from "@ocpp/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { response } from "../location"
import { pluginReadiness } from "./plugin-readiness"

const flushPlugins = pluginReadiness(
  () =>
    new ServiceUnavailableError({
      message: "Model catalog initialization timed out",
      service: "model.catalog",
    }),
)

export const ModelHandler = HttpApiBuilder.group(Api, "server.model", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "model.list",
        Effect.fn(function* () {
          yield* flushPlugins
          const catalog = yield* Catalog.Service
          return yield* response(catalog.model.available())
        }),
      )
      .handle(
        "model.default",
        Effect.fn(function* () {
          yield* flushPlugins
          const catalog = yield* Catalog.Service
          return yield* response(catalog.model.default())
        }),
      )
      .handle(
        "model.drivers",
        Effect.fn(function* () {
          const drivers = yield* ExternalAgentDrivers.Service
          return yield* response(drivers.list())
        }),
      )
  }),
)
