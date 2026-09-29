import { EOL } from "node:os"
import { Effect } from "effect"
import { Ocpp, type PluginInfo } from "@ocpp/client"
import { Service } from "@ocpp/client/effect/service"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"

export default Runtime.handler(
  Commands.commands.plugin.commands.list,
  Effect.fn("cli.plugin.list")(function* (input) {
    const endpoint = yield* Service.ensure(yield* ServiceConfig.options())
    const client = Ocpp.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const response = yield* Effect.promise(() => client.plugin.list({ location: { directory: process.cwd() } }))
    const output = format(response.data, input.builtin)
    if (!output) {
      process.stdout.write("No plugins found" + EOL)
      return
    }
    process.stdout.write(output + EOL)
  }),
)

export function format(plugins: readonly PluginInfo[], builtin = false) {
  return plugins
    .filter((plugin) => builtin || plugin.source.type !== "builtin")
    .toSorted((a, b) => name(a).localeCompare(name(b)))
    .map((plugin) => `${name(plugin)} (${plugin.status})`)
    .join(EOL)
}

function name(plugin: PluginInfo) {
  if (plugin.id) return plugin.id
  if (plugin.source.type === "package") return plugin.source.package
  if (plugin.source.type === "local") return plugin.source.path
  return plugin.source.type
}
