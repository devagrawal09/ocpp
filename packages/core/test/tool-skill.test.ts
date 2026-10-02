import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { SessionInbox } from "@ocpp/schema/session-inbox"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { PluginRuntime } from "@ocpp/core/plugin/runtime"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { SessionMessage } from "@ocpp/core/session/message"
import { Skill } from "@ocpp/core/skill"
import { SkillTool } from "@ocpp/core/tool/plugin/skill"
import { Tool } from "@ocpp/core/tool"
import { tmpdir } from "./fixture/tmpdir"
import { Image } from "@ocpp/core/image"
import { it } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { makeLocationNode } from "@ocpp/util/effect/app-node"
import { FSUtil } from "@ocpp/util/fs-util"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions } from "./lib/tool"

const skillToolNode = makeLocationNode({
  name: "test/skill-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(SkillTool.Plugin)),
  deps: [Tool.node, FSUtil.node, Skill.node, PluginRuntime.node],
})

const sessionID = Session.ID.make("ses_skill_tool_test")

/** Session messages the tool delivered, which is how a loaded skill reaches the model. */
const delivered: Array<Parameters<PluginRuntime.Interface["session"]["synthetic"]>[0]> = []
const unavailable = () => Effect.die("Unavailable in skill tool tests")
const runtime = Layer.mock(PluginRuntime.Service, {
  session: {
    get: unavailable,
    create: unavailable,
    messages: unavailable,
    message: unavailable,
    prompt: unavailable,
    generate: unavailable,
    command: unavailable,
    rename: unavailable,
    move: unavailable,
    resume: unavailable,
    switchAgent: unavailable,
    selectTools: unavailable,
    switchModel: unavailable,
    interrupt: unavailable,
    display: () => Effect.die("unused session.display"),
    synthetic: (input) =>
      Effect.sync(() => {
        delivered.push(input)
        return SessionInbox.Synthetic.make({
          id: SessionMessage.ID.create(),
          sessionID: input.sessionID,
          timeCreated: DateTime.makeUnsafe(0),
          type: "synthetic",
          payload: { text: input.text },
          delivery: "steer",
        })
      }),
    wait: unavailable,
    context: unavailable,
  },
  job: {
    start: unavailable,
    startLimited: unavailable,
    active: unavailable,
    wait: unavailable,
    block: unavailable,
    background: unavailable,
    cancel: unavailable,
    cancelAll: unavailable,
    markBackgroundTerminal: unavailable,
    completeBackground: unavailable,
  },
  persistentPty: { read: unavailable },
  location: { agent: { list: unavailable }, mcp: { list: unavailable }, tool: { paths: unavailable } },
})

describe("SkillTool", () => {
  it.live("lists available skills, authorizes the selected ID, and delivers model-facing content as a message", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, "effect")
          const location = path.join(directory, "SKILL.md")
          const reference = path.join(directory, "reference.md")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* Effect.promise(() =>
            Promise.all([fs.writeFile(location, "unused"), fs.writeFile(reference, "reference")]),
          )

          const info: Skill.Info = {
            id: Skill.ID.make("effect"),
            name: Skill.Name.make("Effect"),
            description: "Use Effect",
            location: AbsolutePath.make(location),
            content: "# Effect\n\nGuidance",
          }
          let current = [info]
          const skills = Layer.mock(Skill.Service, {
            get: (id) => Effect.succeed(current.find((skill) => skill.id === id)),
            list: () => Effect.succeed(current),
          })
          const skillToolLayer = AppNodeBuilder.build(LayerNode.group([Tool.node, skillToolNode]), [
            [Skill.node, skills],
            [Image.node, imagePassthrough],
            [PluginRuntime.node, runtime],
          ])

          return yield* Effect.gen(function* () {
            const registry = yield* Tool.Service
            expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["execute"])
            expect((yield* registry.snapshot()).codeModeCatalog).toEqual([
              expect.objectContaining({ path: "skill", description: SkillTool.description }),
            ])
            delivered.length = 0
            // Code Mode bounds the value a program returns, so the value only confirms the load and the
            // instructions reach the model as their own message.
            const loaded = yield* executeTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-skill", name: "skill", input: { id: "effect" } },
            })
            expect(loaded).toEqual({
              status: "completed",
              output: { name: "Effect", directory, note: expect.stringContaining("separate message") },
              content: [{ type: "text", text: loaded.output.note }],
              metadata: { name: "Effect", directory },
            })
            expect(delivered).toEqual([
              {
                sessionID,
                text: Skill.toModelOutput(info, [reference]),
                description: "Loaded skill Effect",
                metadata: { source: "skill", skill: "effect" },
                resume: false,
              },
            ])
            expect(Skill.toModelOutput(info, [reference])).toContain(`Base directory for this skill: ${directory}`)
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-missing-skill", name: "skill", input: { id: "missing" } },
              }),
            ).toEqual({
              status: "error",
              error: { type: "tool.execution", message: "Unable to load skill missing" },
            })
            expect(delivered).toHaveLength(1)
            const flat = Skill.Info.make({
              id: Skill.ID.make("public"),
              name: Skill.Name.make("Public"),
              description: "Public guidance",
              location: AbsolutePath.make(path.join(tmp.path, "public.md")),
              content: "Public",
            })
            yield* Effect.promise(() =>
              Promise.all([
                fs.writeFile(flat.location, "public"),
                fs.writeFile(path.join(tmp.path, "secret.md"), "secret"),
              ]),
            )
            current = [flat]
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-flat-skill", name: "skill", input: { id: "public" } },
              }),
            ).toMatchObject({ status: "completed", output: { name: "Public" } })
            expect(delivered.at(-1)?.text).toBe(Skill.toModelOutput(flat, []))

            // An oversized skill is cut at 50 KiB, never inside a character, and names the file that holds the rest.
            current = [Skill.Info.make({ ...flat, content: "a" + "é".repeat(40 * 1024) })]
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-large-skill", name: "skill", input: { id: "public" } },
              }),
            ).toMatchObject({ status: "completed" })
            expect(delivered.at(-1)?.text).toContain(
              "a" + "é".repeat(25 * 1024 - 1) + `\n\n[Skill truncated at 50 KiB. Read the rest from ${flat.location}.]`,
            )
          }).pipe(Effect.provide(skillToolLayer))
        }),
      ),
    ),
  )
})
