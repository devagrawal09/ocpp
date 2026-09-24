import { describe, expect } from "bun:test"
import { Bus } from "@ocpp/core/bus"
import { Config } from "@ocpp/core/config"
import { ConfigShellPlugin } from "@ocpp/core/config/plugin/shell"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { Plugin } from "@ocpp/core/plugin"
import { PluginHost } from "@ocpp/core/plugin/host"
import { ShellSelect } from "@ocpp/core/shell/select"
import { Document, Event, Info } from "@ocpp/schema/config"
import { FSUtil } from "@ocpp/util/fs-util"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(Layer.merge(PluginTestLayer, AppNodeBuilder.build(ShellSelect.node)))

describe("ConfigShellPlugin.Plugin", () => {
  it.live("applies the preferred shell and reloads changed config", () =>
    Effect.gen(function* () {
      const shell = yield* ShellSelect.Service
      const bus = yield* Bus.Service
      const config = yield* Config.Test
      const plugins = yield* Plugin.Service
      yield* ConfigShellPlugin.Plugin.effect(yield* PluginHost.make(plugins))

      const configured = process.platform === "win32" ? FSUtil.windowsPath(process.execPath) : process.execPath
      expect(yield* shell.resolve({ priority: "config" })).toBe(configured)

      yield* config.setEntries([])
      yield* bus.publish(Event.Updated, {})
      for (let attempt = 0; attempt < 200; attempt++) {
        if ((yield* shell.resolve({ priority: "config" })) !== configured) return
        yield* Effect.sleep("10 millis")
      }
      yield* Effect.die(new Error("Timed out waiting for shell config reload"))
    }).pipe(
      Effect.provide(
        Config.testLayer([new Document({ type: "document", info: new Info({ shell: process.execPath }) })]),
      ),
    ),
  )
})
