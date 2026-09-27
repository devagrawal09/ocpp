import { describe, expect, test } from "bun:test"
import type { PluginInfo } from "@ocpp/client"
import { pluginLabels } from "./plugin"

describe("pluginLabels", () => {
  test("omits built-in plugins", () => {
    const plugins: PluginInfo[] = [
      { id: "ocpp.internal", source: { type: "builtin" }, status: "active" },
      { id: "package-plugin", source: { type: "package", package: "example" }, status: "active" },
      { id: "local-plugin", source: { type: "local", path: "/tmp/plugin.ts" }, status: "active" },
      { id: "sdk-plugin", source: { type: "sdk" }, status: "active" },
    ]

    expect(pluginLabels(plugins)).toEqual(["package-plugin", "local-plugin", "sdk-plugin"])
  })
})
