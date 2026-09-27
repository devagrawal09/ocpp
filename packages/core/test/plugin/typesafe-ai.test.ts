import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Plugin } from "@ocpp/core/plugin"
import { PluginHost } from "@ocpp/core/plugin/host"
import { PluginPromise } from "@ocpp/core/plugin/promise"
import { Tool } from "@ocpp/core/tool"
import typesafe from "../../../../.ocpp/plugins/typesafe-ai"
import { testEffect } from "../lib/effect"
import { registeredTools } from "../lib/tool"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

describe("TypeSafe plugin", () => {
  it.effect("registers the Jev queries as read-only, so a resumed run calls an interrupted one again", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const registry = yield* Tool.Service
      const host = yield* PluginHost.make(plugins)
      yield* PluginPromise.fromPromise(typesafe).effect(host)

      const tools = yield* registeredTools(registry)
      expect(tools.get("jev_systemOne")?.options).toEqual({ namespace: "jev", readOnly: true })
      expect(tools.get("jev_models_list")?.options).toEqual({ namespace: "jev.models", readOnly: true })
    }),
  )
})
