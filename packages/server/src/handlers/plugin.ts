import { Plugin } from "@ocpp/core/plugin"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Api } from "../api"
import { response } from "../location"

export const PluginHandler = HttpApiBuilder.group(Api, "server.plugin", (handlers) =>
  handlers.handle("plugin.list", () =>
    Effect.gen(function* () {
      return yield* response(Plugin.Service.use((plugin) => plugin.list()))
    }),
  ),
)
