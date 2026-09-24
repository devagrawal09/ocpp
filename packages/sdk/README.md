# @ocpp/sdk

In-process OC++ host for Promise and Effect applications. The SDK executes Server's assembled HTTP router in memory, opening no listener and adding no network hop.

```ts
import { OC++ } from "@ocpp/sdk"

await using ocpp = await OC++.create()
const session = await ocpp.sessions.create({
  location: { directory: "/workspace" },
})
```

Pass imported Promise plugins in `plugins`, or register one later with `await ocpp.plugin(plugin)`.

The Promise API uses the same values, errors, request options, and `AsyncIterable` streams as `@ocpp/client`.

Embedded hosts are silent by default. Set `log` to receive structured log entries:

```ts
await using ocpp = await OC++.create({
  log: {
    level: "warn",
    emit: (entry) => console.error(entry.message, entry.attributes, entry.cause),
  },
})
```

`close()` and `Symbol.asyncDispose` release router resources, Location services, fibers, and scoped plugin registrations.

## Workerd

Use the Workerd entrypoint inside a Cloudflare Durable Object. Hold one host for the lifetime of the object instance rather than creating one per request.

```ts
import { OcppWorkerd } from "@ocpp/sdk/workerd"
import myPlugin from "./my-plugin"

export class OcppDO {
  private readonly ocpp: Promise<OcppWorkerd.Interface>

  constructor(state: DurableObjectState) {
    this.ocpp = state.blockConcurrencyWhile(() =>
      OcppWorkerd.create({
        storage: state.storage,
        config: { default_agent: "build" },
        plugins: [myPlugin],
      }),
    )
  }

  async fetch() {
    const ocpp = await this.ocpp
    return Response.json(await ocpp.health.get())
  }
}
```

`blockConcurrencyWhile` keeps every Durable Object event out until the host is ready and resets the object if initialization fails. The retained Promise gives request handlers direct access to the same host after startup. Configuration is a typed JavaScript object, and plugins are imported values bundled with the Worker.

## Effect

The Effect-native API remains available from `@ocpp/sdk/effect`:

```ts
import { OC++ } from "@ocpp/sdk/effect"

const ocpp = yield * OC++.create()
const session = yield * ocpp.sessions.get({ sessionID })
```

The Effect Workerd entrypoint is `@ocpp/sdk/workerd/effect`.
