import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Duration, Effect, Layer, LayerMap } from "effect"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Global } from "@ocpp/util/global"
import { Config } from "@ocpp/core/config"
import { Instance } from "@ocpp/core/instance"
import { InstructionDiscovery } from "@ocpp/core/instruction-discovery"
import { LocationServiceMap } from "@ocpp/core/location-services"
import { Location } from "@ocpp/core/location"
import { PluginSupervisor } from "@ocpp/core/plugin/supervisor"
import { SdkPlugins } from "@ocpp/core/plugin/sdk"
import { AbsolutePath } from "@ocpp/core/schema"
import { Tool } from "@ocpp/core/tool"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { testEffect } from "./lib/effect"
import { Database } from "../src/database/database"
import { Bus } from "../src/bus"

// Config the host hands the vanilla instance explicitly: a value and an
// explicit plugin removal, both of which must survive discovery: false.
const hostConfig: LayerNode.Replacements = [
  [
    Config.node,
    Config.configured({
      project: false,
      global: false,
      content: JSON.stringify({ shell: "vanilla-host", plugins: ["-ocpp.tool.shell"] }),
    }),
  ],
]

// Same directory contents, two instances: one vanilla, one with discovery.
const instances = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    (ref: Location.Ref) => {
      const name = path.basename(ref.directory)
      return Instance.layer(ref, {
        // "bare" exercises the vanilla defaults themselves: no caller Config.
        discovery: name !== "vanilla" && name !== "bare",
        // Caller replacements win over the vanilla defaults.
        replacements: [[Global.node, tempGlobalLayer], ...(name === "vanilla" ? hostConfig : [])],
      })
    },
    { idleTimeToLive: Duration.infinity },
  ),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SdkPlugins.node, LocationServiceMap.node]), [
    [Global.node, tempGlobalLayer],
    [LocationServiceMap.node, instances],
  ]),
)

describe("Instance vanilla", () => {
  it.live("boots without filesystem config discovery", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const locations = yield* LocationServiceMap.Service
          const plant = (name: string) =>
            Effect.promise(async () => {
              const directory = path.join(dir.path, name)
              await fs.mkdir(directory)
              await fs.writeFile(path.join(directory, "ocpp.json"), "{}")
              await fs.writeFile(path.join(directory, "AGENTS.md"), "planted instructions")
              return Location.Ref.make({ directory: AbsolutePath.make(directory) })
            })

          const read = (ref: Location.Ref) =>
            Effect.gen(function* () {
              const supervisor = yield* PluginSupervisor.Service
              yield* supervisor.flush
              const config = yield* Config.Service
              const discovery = yield* InstructionDiscovery.Service
              const tools = yield* Tool.Service
              const entries = yield* config.entries()
              return {
                documents: entries.filter(
                  (entry) => "path" in entry && typeof entry.path === "string" && entry.path.startsWith(ref.directory),
                ),
                instructions: yield* discovery.list(),
                shell: Config.latest(entries, "shell"),
                toolNames: ((yield* tools.snapshot()).codeModeCatalog ?? []).map((tool) => tool.path),
              }
            }).pipe(Effect.scoped, Effect.provide(locations.get(ref)))

          const vanilla = yield* read(yield* plant("vanilla"))
          expect(vanilla.documents).toEqual([])
          expect(vanilla.instructions).toEqual([])
          // Host-injected content survives discovery: false, including its
          // explicit plugin operations.
          expect(vanilla.shell).toBe("vanilla-host")
          expect(vanilla.toolNames).not.toContain("shell")

          // Bare vanilla: the defaults themselves, with no caller Config.
          const bare = yield* read(yield* plant("bare"))
          expect(bare.documents).toEqual([])
          expect(bare.instructions).toEqual([])
          expect(bare.shell).toBeUndefined()
          expect(bare.toolNames).toContain("shell")

          const discovery = yield* read(yield* plant("discovery"))
          expect(discovery.documents.length).toBeGreaterThan(0)
          expect(
            Array.isArray(discovery.instructions) &&
              discovery.instructions.some((file) => file.path.endsWith("AGENTS.md")),
          ).toBe(true)
          expect(discovery.toolNames).toContain("shell")
        }),
      ),
    ),
  )

  it.live("does not execute ambient plugin modules", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const locations = yield* LocationServiceMap.Service
          const directory = path.join(dir.path, "vanilla")
          const marker = path.join(directory, "ambient-loaded.txt")
          // A plugin module whose import writes a sentinel: project-marker
          // discovery used to import it during vanilla boot.
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(directory, ".ocpp", "plugins"), { recursive: true })
            await fs.writeFile(
              path.join(directory, ".ocpp", "plugins", "ambient.ts"),
              [
                'import { writeFile } from "node:fs/promises"',
                `await writeFile(${JSON.stringify(marker)}, "loaded")`,
                'export default { id: "ambient-plugin", setup() {} }',
              ].join("\n"),
            )
          })
          const ref = Location.Ref.make({ directory: AbsolutePath.make(directory) })
          yield* Effect.gen(function* () {
            const supervisor = yield* PluginSupervisor.Service
            yield* supervisor.flush
            const config = yield* Config.Service
            // Only the pathless host-injected document; nothing file-backed.
            const entries = yield* config.entries()
            expect(entries.filter((entry) => "path" in entry && typeof entry.path === "string")).toEqual([])
          }).pipe(Effect.scoped, Effect.provide(locations.get(ref)))
          expect(yield* Effect.promise(() => Bun.file(marker).exists())).toBe(false)
        }),
      ),
    ),
  )
})
