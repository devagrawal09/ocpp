import { EOL } from "os"
import { Effect } from "effect"
import { Ocpp } from "@ocpp/client"
import { Service } from "@ocpp/client/effect/service"
import { Commands } from "../../commands"
import { Runtime } from "../../../framework/runtime"
import { ServiceConfig } from "../../../services/service-config"

export default Runtime.handler(
  Commands.commands.debug.commands.config,
  Effect.fn("cli.debug.config")(function* () {
    const endpoint = yield* Service.ensure(yield* ServiceConfig.options())
    const client = Ocpp.make({ baseUrl: endpoint.url })
    const entries = yield* Effect.promise(() => client.config.get({ location: { directory: process.cwd() } }))
    process.stdout.write(JSON.stringify(entries, null, 2) + EOL)
  }),
)
