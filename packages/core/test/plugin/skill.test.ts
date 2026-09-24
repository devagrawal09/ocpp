import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { ConfigPluginSource } from "@ocpp/core/config/plugin/source"
import { Effect, Layer, Stream } from "effect"
import { SkillPlugin } from "@ocpp/core/plugin/skill"
import { Skill } from "@ocpp/core/skill"
import { testEffect } from "../lib/effect"
import { host } from "./host"

const it = testEffect(AppNodeBuilder.build(Skill.node))
const sources = (operations: readonly ConfigPluginSource.Operation[] = []) =>
  Layer.succeed(
    ConfigPluginSource.Service,
    ConfigPluginSource.Service.of({ operations: () => Effect.succeed(operations), changes: () => Stream.never }),
  )

describe("SkillPlugin.Plugin", () => {
  it.effect("registers built-in skills", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      yield* SkillPlugin.Plugin.effect(
        host({
          app: { name: "test", version: "1.2.3", channel: "beta" },
          skill: {
            list: () => Effect.die("unused skill.list"),
            transform: skill.transform,
            reload: skill.reload,
          },
        }),
      ).pipe(Effect.provide(sources()))
      const skills = yield* skill.list()
      const report = skills.find((item) => item.id === "report")

      expect(skills).toContainEqual(
        expect.objectContaining({
          id: "ocpp",
          name: "OC++",
          description: expect.stringContaining("any question about OC++ itself"),
        }),
      )
      expect(skills).toContainEqual(
        expect.objectContaining({
          id: "report",
          name: "Report",
          description: expect.stringContaining("ocpp issue"),
        }),
      )
      expect(report?.slash).toBe(true)
      expect(report?.content).toContain("- ocpp version: 1.2.3")
      expect(report?.content).toContain("- install/channel: beta")
    }),
  )

  it.effect("reports canonical configured plugin sources with existing labels and ordering", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      yield* SkillPlugin.Plugin.effect(
        host({
          skill: {
            list: () => Effect.die("unused skill.list"),
            transform: skill.transform,
            reload: skill.reload,
          },
        }),
      )
      const report = (yield* skill.list()).find((item) => item.id === "report")
      expect(report?.content).toContain("- Active plugins: -disabled, local.ts, package-plugin, package-plugin")
    }).pipe(
      Effect.provide(
        sources([
          { type: "add", target: "package-plugin", options: {} },
          { type: "remove", target: "disabled" },
          { type: "add", target: "local.ts", options: {}, mtime: 1 },
          { type: "add", target: "package-plugin", options: { enabled: true } },
        ]),
      ),
    ),
  )
})
