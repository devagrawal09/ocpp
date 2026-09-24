import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Catalog } from "@ocpp/core/catalog"
import { Integration } from "@ocpp/core/integration"
import { Plugin } from "@ocpp/core/plugin"
import { PluginHost } from "@ocpp/core/plugin/host"
import { ProviderPlugins } from "@ocpp/core/plugin/provider"
import { LLMGatewayPlugin } from "@ocpp/core/plugin/provider/llmgateway"
import { Provider } from "@ocpp/core/provider"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

const addPlugin = Effect.fn(function* () {
  const plugin = yield* Plugin.Service
  const host = yield* PluginHost.make(plugin)
  yield* LLMGatewayPlugin.effect(host)
})

describe("LLMGatewayPlugin", () => {
  test("is registered so legacy referer headers can be applied", () => {
    expect(ProviderPlugins.map((item) => item.id)).toContain("ocpp.provider.llmgateway")
  })

  it.effect("applies legacy referer headers only to enabled llmgateway", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      yield* integrations.transform((editor) => {
        editor.update(Integration.ID.make("llmgateway"), () => {})
        editor.update(Integration.ID.make("openrouter"), () => {})
      })
      yield* catalog.transform((catalog) => {
        catalog.provider.update(Provider.ID.make("llmgateway"), (provider) => {
          provider.package = Provider.aisdk("@ai-sdk/openai-compatible")
          provider.settings = { baseURL: "https://api.llmgateway.io/v1" }
          provider.headers = { Existing: "value" }
        })
        catalog.provider.update(Provider.ID.openrouter, () => {})
      })
      yield* addPlugin()
      expect((yield* catalog.provider.get(Provider.ID.make("llmgateway")))?.headers).toEqual({
        Existing: "value",
        "HTTP-Referer": "https://ocpp.ai/",
        "X-Title": "ocpp",
        "X-Source": "ocpp",
      })
      expect((yield* catalog.provider.get(Provider.ID.openrouter))?.headers).toBeUndefined()
    }),
  )

  it.effect("does not apply legacy headers to a disabled llmgateway provider", () =>
    Effect.gen(function* () {
      const catalog = yield* Catalog.Service
      const integrations = yield* Integration.Service
      yield* integrations.transform((editor) => {
        editor.update(Integration.ID.make("llmgateway"), () => {})
      })
      yield* catalog.transform((catalog) => {
        catalog.provider.update(Provider.ID.make("llmgateway"), (provider) => {
          provider.activation = "disabled"
          provider.package = Provider.aisdk("@ai-sdk/openai-compatible")
          provider.settings = { baseURL: "https://api.llmgateway.io/v1" }
        })
      })
      yield* addPlugin()

      expect((yield* catalog.provider.get(Provider.ID.make("llmgateway")))?.activation).toBe("disabled")
      expect((yield* catalog.provider.get(Provider.ID.make("llmgateway")))?.headers).toBeUndefined()
    }),
  )
})
