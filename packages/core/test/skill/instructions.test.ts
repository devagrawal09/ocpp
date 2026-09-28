import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { AbsolutePath } from "@ocpp/core/schema"
import { Skill } from "@ocpp/core/skill"
import { SkillInstructions } from "@ocpp/core/skill/instructions"
import { it } from "../lib/effect"
import { readInitial, readUpdate } from "../lib/instructions"

const effect = Skill.Info.make({
  id: Skill.ID.make("effect"),
  name: Skill.Name.make("Effect"),
  description: "Build applications with Effect",
  location: AbsolutePath.make(path.resolve("/skills/effect/SKILL.md")),
  content: "Effect guidance",
})
const hidden = Skill.Info.make({
  id: Skill.ID.make("hidden"),
  name: Skill.Name.make("Hidden"),
  location: AbsolutePath.make(path.resolve("/skills/hidden/SKILL.md")),
  content: "Undescribed guidance",
})
const manual = Skill.Info.make({
  id: Skill.ID.make("manual"),
  name: Skill.Name.make("Manual"),
  description: "Load only when explicitly selected",
  autoinvoke: false,
  location: AbsolutePath.make(path.resolve("/skills/manual/SKILL.md")),
  content: "Manual guidance",
})

const layer = (list: () => Skill.Info[]) =>
  AppNodeBuilder.build(SkillInstructions.node, [
    [Skill.node, Layer.mock(Skill.Service, { list: () => Effect.succeed(list()) })],
  ])

describe("SkillInstructions", () => {
  it.effect("renders described agent skills and updates the complete available list", () => {
    let skills = [hidden, manual, effect]
    return Effect.gen(function* () {
      const instructions = yield* SkillInstructions.Service
      const initialized = yield* instructions.load(["skill"]).pipe(Effect.flatMap(readInitial))

      expect(initialized.text).toBe(
        [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Call `tools.skill({ id })` to load a skill when a task matches its description. Its full instructions arrive as a separate message, no later than that execution's completion notification.",
          "<available_skills>",
          "  <skill>",
          "    <id>effect</id>",
          "    <name>Effect</name>",
          "    <description>Build applications with Effect</description>",
          "  </skill>",
          "</available_skills>",
        ].join("\n"),
      )
      expect(initialized.text).not.toContain("manual")

      skills = []
      expect(
        yield* instructions.load(["skill"]).pipe(Effect.flatMap((context) => readUpdate(context, initialized))),
      ).toMatchObject({ text: "Skill guidance is no longer available. Do not use any previously listed skill." })
    }).pipe(Effect.provide(layer(() => skills)))
  })

  it.effect("announces added and removed skills as deltas without restating the list", () => {
    const debugging = Skill.Info.make({
      id: Skill.ID.make("debugging"),
      name: Skill.Name.make("Debugging"),
      description: "Diagnose hard bugs",
      location: AbsolutePath.make(path.resolve("/skills/debugging/SKILL.md")),
      content: "Debugging guidance",
    })
    let skills = [effect]
    return Effect.gen(function* () {
      const instructions = yield* SkillInstructions.Service
      const initialized = yield* instructions.load(["skill"]).pipe(Effect.flatMap(readInitial))

      skills = [effect, debugging]
      const added = yield* instructions
        .load(["skill"])
        .pipe(Effect.flatMap((context) => readUpdate(context, initialized)))
      expect(added.text).toBe(
        [
          "New skills are available in addition to those previously listed:",
          "  <skill>",
          "    <id>debugging</id>",
          "    <name>Debugging</name>",
          "    <description>Diagnose hard bugs</description>",
          "  </skill>",
        ].join("\n"),
      )

      skills = [debugging]
      const removed = yield* instructions.load(["skill"]).pipe(Effect.flatMap((context) => readUpdate(context, added)))
      expect(removed.text).toBe("The following skill IDs are no longer available and must not be used: effect.")
    }).pipe(Effect.provide(layer(() => skills)))
  })

  it.effect("restates the full skill list when a description changes", () => {
    let skills = [effect]
    return Effect.gen(function* () {
      const instructions = yield* SkillInstructions.Service
      const initialized = yield* instructions.load(["skill"]).pipe(Effect.flatMap(readInitial))

      skills = [Skill.Info.make({ ...effect, description: "Build applications with Effect v4" })]
      expect(
        yield* instructions.load(["skill"]).pipe(Effect.flatMap((context) => readUpdate(context, initialized))),
      ).toMatchObject({
        text: expect.stringContaining(
          "The available skills have changed. This list supersedes the previous available skills list.",
        ),
      })
    }).pipe(Effect.provide(layer(() => skills)))
  })

  it.effect("omits instructions when the tool list has no skill tool", () => {
    return Effect.gen(function* () {
      const instructions = yield* SkillInstructions.Service
      expect((yield* instructions.load(["read", "grep"]).pipe(Effect.flatMap(readInitial))).text).toBe("")
    }).pipe(Effect.provide(layer(() => [effect])))
  })
})
