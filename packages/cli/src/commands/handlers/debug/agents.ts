import { EOL } from "os"
import { Effect } from "effect"
import { Ocpp } from "@ocpp/client"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { Service } from "@ocpp/client/effect/service"
import { ServiceConfig } from "../../../services/service-config"

export default Runtime.handler(
  Commands.commands.debug.commands.agents,
  Effect.fn("cli.debug.agents")(function* () {
    const endpoint = yield* Service.ensure(yield* ServiceConfig.options())
    const client = Ocpp.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
    const response = yield* Effect.promise(() => client.agent.list({ location: { directory: process.cwd() } }))
    process.stdout.write(
      JSON.stringify(
        response.data.toSorted((a, b) => a.id.localeCompare(b.id)),
        null,
        2,
      ) + EOL,
    )
  }),
)
