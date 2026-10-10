import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Bus } from "@ocpp/core/bus"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { Watcher } from "@ocpp/core/filesystem/watcher"
import { PersistentPty } from "@ocpp/core/persistent-pty"
import { PluginRuntime } from "@ocpp/core/plugin/runtime"
import { Session } from "@ocpp/schema/session"
import { Global } from "@ocpp/util/global"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { tempGlobalLayer } from "../fixture/global"
import { testEffect } from "../lib/effect"
import { TestStepHost } from "../fixture/step-host"

const cell = PluginRuntime.makeCell()

const steps = TestStepHost.make()
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Global.node,
      Bus.node,
      PersistentPty.node,
      PluginRuntime.node,
      PluginRuntime.providerNodeWithCell(cell),
    ]),
    [
      [Global.node, tempGlobalLayer],
      [Watcher.node, Watcher.configured({ enabled: false })],
      steps.replacement,
      [PluginRuntime.node, PluginRuntime.layerWithCell(cell)],
      [PersistentPty.node, PersistentPty.configured()],
    ],
  ),
)

describe("Plugin runtime terminal reads", () => {
  it.live("shares the configured global PTY service and validates lines before an empty selection", () =>
    Effect.gen(function* () {
      const runtime = yield* PluginRuntime.Service
      const persistentPty = yield* PersistentPty.Service
      const sessionID = Session.ID.make("ses_no_terminal")

      expect(cell.runtime?.persistentPty).toBe(persistentPty)
      expect(yield* runtime.persistentPty.read(sessionID)).toBeNull()
      expect(yield* runtime.persistentPty.read(sessionID, 1)).toBeNull()
      expect(yield* runtime.persistentPty.read(sessionID, 65535)).toBeNull()
      yield* Effect.forEach([0, -1, 1.5, 65536, NaN, Infinity], (lines) =>
        Effect.gen(function* () {
          const error = yield* runtime.persistentPty.read(sessionID, lines).pipe(Effect.flip)
          expect(error).toBeInstanceOf(PersistentPty.UnavailableError)
          expect(error.message).toContain("lines")
        }),
      )
    }),
  )
})
