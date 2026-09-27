export * as SkillTool from "./skill.js"

import type { Context } from "@ocpp/plugin/effect/plugin"
import { ToolFailure } from "@ocpp/ai"
import { Effect, Schema } from "effect"
import { FSUtil } from "@ocpp/util/fs-util"
import { PluginRuntime } from "../../plugin/runtime.js"
import { Skill } from "../../skill.js"
import { Permission } from "../../permission.js"

export const name = "skill"

export const Input = Schema.Struct({
  id: Skill.ID.annotate({ description: "The ID of an available skill or a skill explicitly referenced by the user" }),
})

export const Output = Schema.Struct({
  name: Skill.Name,
  directory: Schema.String,
  note: Schema.String,
})
export const description = [
  "Load a specialized skill's instructions and resources when the task at hand matches its description.",
  "The full instructions reach you as a separate message, no later than this execution's completion notification. The returned value only confirms the load.",
  "",
  "The skill ID must match an available skill or a skill explicitly referenced by the user.",
].join("\n")

const note =
  "The skill's full instructions were added to the conversation as a separate message. They arrive no later than this execution's completion notification."

/** The generic tool output bound that applied when a skill loaded as a direct tool result. */
const MAX_SKILL_BYTES = 50 * 1024

export const toModelOutput = Skill.toModelOutput

const unableToLoad = (name: string, error?: unknown) =>
  new ToolFailure({ message: `Unable to load skill ${name}`, error })

export const Plugin = {
  id: "ocpp.tool.skill",
  effect: Effect.fn("SkillTool.Plugin")(function* (ctx: Context) {
    const fs = yield* FSUtil.Service
    const skills = yield* Skill.Service
    const permission = yield* Permission.Service
    const runtime = yield* PluginRuntime.Service
    yield* ctx.tool
      .transform((draft) =>
        draft.add({
          name,
          options: { readOnly: true },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const skill = yield* skills.get(input.id)
              if (!skill) return yield* unableToLoad(input.id)
              return yield* Effect.gen(function* () {
                yield* permission.assert({
                  action: name,
                  resources: [skill.id],
                  save: [skill.id],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.messageID, id: context.id },
                })
                const prepared = yield* Skill.prepare(fs, bounded(skill))
                // Code Mode bounds what an execution returns, so the instructions travel as their own message, like
                // an `@skill` mention's. It waits for the completion to wake the model rather than waking it early.
                yield* runtime.session.synthetic({
                  sessionID: context.sessionID,
                  text: prepared.output,
                  description: "Loaded skill " + skill.name,
                  metadata: { source: "skill", skill: skill.id },
                  resume: false,
                })
                return { name: skill.name, directory: prepared.directory, note }
              }).pipe(Effect.mapError((error) => unableToLoad(input.id, error)))
            }).pipe(
              Effect.map((output) => ({
                output,
                content: output.note,
                metadata: { name: output.name, directory: output.directory },
              })),
            ),
        }),
      )
      .pipe(Effect.orDie)
  }),
}

function bounded(skill: Skill.Info): Skill.Info {
  const bytes = new TextEncoder().encode(skill.content)
  if (bytes.length <= MAX_SKILL_BYTES) return skill
  const text = new TextDecoder().decode(bytes.slice(0, MAX_SKILL_BYTES))
  return {
    ...skill,
    content:
      (text.endsWith("\uFFFD") ? text.slice(0, -1) : text) +
      "\n\n[Skill truncated at " +
      MAX_SKILL_BYTES / 1024 +
      " KiB. Read the rest from " +
      skill.location +
      ".]",
  }
}
