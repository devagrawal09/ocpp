import { expect } from "bun:test"
import { Effect } from "effect"
import { makeDurableObjectStorage } from "../../core/test/fixture/durable-object-storage"
import { it } from "../../core/test/lib/effect"
import { ServerWorkerd } from "../src/workerd"

// Covers the profile's replacement graph composing and the database booting
// through the injected Durable Object storage.
it.live("boots the workerd profile over durable object storage", () =>
  Effect.gen(function* () {
    const handler = yield* ServerWorkerd.create({
      storage: makeDurableObjectStorage(),
      app: { version: "workerd-test" },
      config: { content: "{}" },
    })

    const health = yield* Effect.promise(() => handler(new Request("http://ocpp.local/api/health")))
    expect(health.status).toBe(200)

    const body: unknown = yield* Effect.promise(() => health.json())
    expect(body).toMatchObject({ healthy: true, version: "workerd-test" })
  }),
)
