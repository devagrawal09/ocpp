import { AISDK } from "@ocpp/core/aisdk"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Catalog } from "@ocpp/core/catalog"
import { Model } from "@ocpp/core/model"
import { Plugin } from "@ocpp/core/plugin"
import { PluginHost } from "@ocpp/core/plugin/host"
import { VercelPlugin } from "@ocpp/core/plugin/provider/vercel"
import { Provider } from "@ocpp/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* VercelPlugin.effect(host)
})

describe("VercelPlugin", () => {
  it.effect("applies legacy lower-case referer headers", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => {
        catalog.provider.update(Provider.ID.make("vercel"), (provider) => {
          provider.package = Provider.aisdk("@ai-sdk/vercel")
          provider.headers = { ...provider.headers, Existing: "1" }
        })
      })
      yield* addPlugin()
      expect((yield* catalog.provider.get(Provider.ID.make("vercel")))?.headers).toEqual({
        Existing: "1",
        "http-referer": "https://ocpp.ai/",
        "x-title": "ocpp",
      })
    }),
  )

  it.effect("does not add legacy upper-case referer headers", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) =>
        catalog.provider.update(Provider.ID.make("vercel"), (provider) => {
          provider.package = Provider.aisdk("@ai-sdk/vercel")
        }),
      )
      yield* addPlugin()
      expect((yield* catalog.provider.get(Provider.ID.make("vercel")))?.headers).not.toHaveProperty("HTTP-Referer")
      expect((yield* catalog.provider.get(Provider.ID.make("vercel")))?.headers).not.toHaveProperty("X-Title")
    }),
  )

  it.effect("creates @ai-sdk/vercel SDKs for custom provider IDs", () =>
    Effect.gen(function* () {
      const aisdk = yield* AISDK.Service
      yield* addPlugin()
      const event = yield* aisdk.runSDK({
        model: Model.Info.make({
          ...Model.Info.default(Provider.ID.make("custom-vercel"), Model.ID.make("v0-1.0-md")),
          modelID: Model.ID.make("v0-1.0-md"),
          package: "aisdk:@ai-sdk/vercel",
        }),
        package: "@ai-sdk/vercel",
        options: { name: "custom-vercel" },
      })
      expect(event.sdk).toBeDefined()
      expect(event.sdk.languageModel("v0-1.0-md").provider).toBe("vercel.chat")
    }),
  )

  it.effect("ignores non-Vercel providers", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      yield* catalog.transform((catalog) => catalog.provider.update(Provider.ID.make("gateway"), () => {}))
      yield* addPlugin()
      expect((yield* catalog.provider.get(Provider.ID.make("gateway")))?.headers).toBeUndefined()
    }),
  )
})
