import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Fiber, Schema, Stream } from "effect"
import { Agent } from "@ocpp/core/agent"
import { Bus } from "@ocpp/core/bus"
import { Config } from "@ocpp/core/config"
import { Directory, Document, Info } from "@ocpp/schema/config"
import { ConfigAgentPlugin } from "@ocpp/core/config/plugin/agent"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { FSUtil } from "@ocpp/util/fs-util"
import { Global } from "@ocpp/util/global"
import { AgentPlugin } from "@ocpp/core/plugin/agent"
import { AbsolutePath } from "@ocpp/core/schema"
import { ConfigAgentV1 } from "@ocpp/core/v1/config/agent"
import { advance, drain } from "../lib/clock"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"
import { agentHost, host } from "../plugin/host"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Agent.node, Bus.node, FSUtil.node, Global.node])))
const decode = Schema.decodeUnknownSync(Info)

test("rejects named agent color tokens", () => {
  expect(() => decode({ agents: { reviewer: { color: "warning" } } })).toThrow()
})

test("keeps schema fields and name out of legacy agent options", () => {
  const agent = Schema.decodeUnknownSync(ConfigAgentV1.Info)({
    name: "reviewer",
    model: "test/model",
    variant: "high",
    temperature: 0.5,
    top_p: 0.9,
    prompt: "Review carefully.",
    tools: { edit: false },
    disable: false,
    description: "Reviews changes",
    mode: "subagent",
    hidden: true,
    options: { existing: true },
    color: "#112233",
    steps: 10,
    maxSteps: 20,
    permission: { read: "allow" },
    custom: "preserved",
  })

  expect(agent.options).toEqual({ existing: true, custom: "preserved" })
})

describe("ConfigAgentPlugin.Plugin", () => {
  it.effect("maps configured agent fields and preserves an unspecified model variant", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const entries = [
        new Document({
          type: "document",
          info: decode({
            agents: {
              reviewer: {
                model: "anthropic/claude-sonnet",
                system: "Review carefully.",
                description: "Reviews changes",
                mode: "subagent",
                hidden: true,
                color: "#ff6b6b",
                steps: 12,
                request: {
                  headers: { first: "one", shared: "first" },
                  body: { enabled: true, profile: "review", effort: "medium" },
                },
              },
            },
          }),
        }),
        new Document({
          type: "document",
          info: decode({
            agents: {
              reviewer: {
                request: {
                  headers: { shared: "last", second: "two" },
                  body: { retries: 2, effort: "high" },
                },
              },
            },
          }),
        }),
      ]

      yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
        Effect.provide(Config.testLayer(entries)),
      )

      const reviewer = yield* agents.get(Agent.ID.make("reviewer"))
      if (!reviewer) throw new Error("expected configured reviewer agent")
      expect(reviewer).toMatchObject({
        system: "Review carefully.",
        description: "Reviews changes",
        mode: "subagent",
        hidden: true,
        color: "#ff6b6b",
        steps: 12,
        model: { providerID: "anthropic", id: "claude-sonnet" },
      })
      expect(reviewer.request).toEqual({
        settings: {},
        headers: { first: "one", shared: "last", second: "two" },
        body: { enabled: true, profile: "review", retries: 2, effort: "high" },
      })
    }),
  )

  it.effect("removes a built-in agent disabled by configuration", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const build = Agent.ID.make("build")
      yield* agents.transform((editor) => editor.update(build, () => {}))

      const entries = [
        new Document({
          type: "document",
          info: decode({ agents: { build: { disabled: true } } }),
        }),
      ]

      yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
        Effect.provide(Config.testLayer(entries)),
      )

      expect(yield* agents.get(build)).toBeUndefined()
    }),
  )

  it.live("loads legacy file-based agents from config directories", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.join(tmp.path, "agents", "team"), { recursive: true })
            await fs.mkdir(path.join(tmp.path, "modes"), { recursive: true })
            await fs.writeFile(
              path.join(tmp.path, "agents", "reviewer.md"),
              `---
model: openrouter/openai/gpt-5
description: Markdown description
temperature: 0.5
tools:
  write: false
---
Review carefully.`,
            )
            await fs.writeFile(path.join(tmp.path, "agents", "team", "helper.md"), "Help the team.")
            await fs.writeFile(
              path.join(tmp.path, "agents", "native.md"),
              `---
variant: high
request:
  headers:
    x-agent: native
  body:
    effort: high
permissions:
  - action: edit
    resource: "*"
    effect: deny
---
Use native v2 fields.`,
            )
            await fs.writeFile(path.join(tmp.path, "agents", "disabled.md"), "---\ndisabled: true\n---\nDisabled")
            await fs.writeFile(path.join(tmp.path, "agents", "empty.md"), "")
            await fs.writeFile(path.join(tmp.path, "modes", "plan.md"), "Make a plan.")
          })
          const agents = yield* Agent.Service
          const entries = [
            new Document({
              type: "document",
              info: decode({ agents: { reviewer: { description: "JSON description" } } }),
            }),
            directoryEntry(tmp.path),
          ]

          yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) })).pipe(
            Effect.provide(Config.testLayer(entries)),
          )

          expect(yield* agents.get(Agent.ID.make("reviewer"))).toMatchObject({
            model: { providerID: "openrouter", id: "openai/gpt-5" },
            system: "Review carefully.",
            description: "Markdown description",
            request: { body: { temperature: 0.5 } },
          })
          expect(yield* agents.get(Agent.ID.make("team/helper"))).toMatchObject({ system: "Help the team." })
          expect(yield* agents.get(Agent.ID.make("native"))).toMatchObject({
            system: "Use native v2 fields.",
            request: { headers: { "x-agent": "native" }, body: { effort: "high" } },
          })
          // Removed permission rules still load; the agent takes its tools from its tool list instead.
          expect(yield* agents.get(Agent.ID.make("native"))).not.toHaveProperty("permissions")
          expect(yield* agents.get(Agent.ID.make("disabled"))).toBeUndefined()
          expect(yield* agents.get(Agent.ID.make("empty"))).toBeUndefined()
          expect(yield* agents.get(Agent.ID.make("plan"))).toMatchObject({ system: "Make a plan.", mode: "primary" })
        }),
      ),
    ),
  )

  for (const testCase of sourceCases()) {
    it.effect(`rebuilds agents when a source file is ${testCase.name}`, () =>
      Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
        Effect.flatMap((tmp) =>
          Effect.gen(function* () {
            const directory = path.join(tmp.path, testCase.source)
            yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
            yield* testCase.prepare(directory)

            const agents = yield* Agent.Service
            const bus = yield* Bus.Service
            const configTest = yield* Config.Test
            yield* ConfigAgentPlugin.Plugin.effect(host({ agent: agentHost(agents) }))

            // Verify inside the subscription so the update event is a read barrier:
            // committed state must be visible at event delivery time.
            let received = 0
            const changed = yield* bus.subscribe(Agent.Event.Updated).pipe(
              Stream.take(1),
              Stream.tap(() => Effect.sync(() => received++)),
              Stream.mapEffect(() => testCase.verify(agents)),
              Stream.runDrain,
              Effect.forkScoped({ startImmediately: true }),
            )
            yield* Effect.yieldNow

            const updates = yield* testCase.mutate(directory)
            yield* Effect.forEach(updates, (update) => configTest.emitChange(update), { discard: true })
            yield* advance(() => received === 1)
            yield* Fiber.join(changed)
          }).pipe(Effect.provide(Config.testLayer([directoryEntry(tmp.path)]))),
        ),
      ),
    )
  }

  it.effect("coalesces updates inside the debounce window into one rebuild", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, "agents")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))

          const agents = yield* Agent.Service
          const configTest = yield* Config.Test
          let reloads = 0
          yield* ConfigAgentPlugin.Plugin.effect(
            host({
              agent: {
                ...agentHost(agents),
                reload: () => agents.reload().pipe(Effect.tap(() => Effect.sync(() => reloads++))),
              },
            }),
          )
          yield* Effect.yieldNow

          yield* Effect.promise(() => fs.writeFile(path.join(directory, "reviewer.md"), "Review once"))
          yield* configTest.emitChange({ type: "create", path: path.join(directory, "reviewer.md") })
          yield* configTest.emitChange({ type: "update", path: path.join(directory, "reviewer.md") })
          yield* configTest.emitChange({ type: "update", path: path.join(directory, "reviewer.md") })
          yield* advance(() => reloads >= 1)
          expect(reloads).toBe(1)

          yield* Effect.promise(() => fs.writeFile(path.join(directory, "reviewer.md"), "Review twice"))
          yield* configTest.emitChange({ type: "update", path: path.join(directory, "reviewer.md") })
          yield* advance(() => reloads >= 2)
          expect(reloads).toBe(2)
          expect(yield* agents.get(Agent.ID.make("reviewer"))).toMatchObject({ system: "Review twice" })
        }).pipe(Effect.provide(Config.testLayer([directoryEntry(tmp.path)]))),
      ),
    ),
  )

  it.effect("ignores updates outside agent source directories", () =>
    Effect.acquireDisposable(Effect.promise(() => tmpdir())).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, "agents")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))

          const agents = yield* Agent.Service
          const configTest = yield* Config.Test
          let reloads = 0
          yield* ConfigAgentPlugin.Plugin.effect(
            host({
              agent: {
                ...agentHost(agents),
                reload: () => agents.reload().pipe(Effect.tap(() => Effect.sync(() => reloads++))),
              },
            }),
          )

          yield* configTest.emitChange({ type: "create", path: path.join(tmp.path, "commands", "review.md") })
          yield* configTest.emitChange({ type: "update", path: path.join(tmp.path, "ocpp.json") })
          yield* drain
          expect(reloads).toBe(0)

          // The feed stays live after unrelated updates.
          yield* Effect.promise(() => fs.writeFile(path.join(directory, "reviewer.md"), "Review related"))
          yield* configTest.emitChange({ type: "create", path: path.join(directory, "reviewer.md") })
          yield* advance(() => reloads >= 1)
          expect(yield* agents.get(Agent.ID.make("reviewer"))).toMatchObject({ system: "Review related" })
        }).pipe(Effect.provide(Config.testLayer([directoryEntry(tmp.path)]))),
      ),
    ),
  )
})

function directoryEntry(directory: string) {
  return new Directory({ type: "directory", path: AbsolutePath.make(directory) })
}

function sourceCases() {
  return [
    {
      name: "created",
      source: "agents",
      prepare: () => Effect.void,
      mutate: (directory: string) =>
        Effect.promise(async () => {
          const file = path.join(directory, "reviewer.md")
          await fs.writeFile(file, "Review changes")
          return [{ type: "create" as const, path: file }]
        }),
      verify: (agents: Agent.Interface) =>
        Effect.gen(function* () {
          expect(yield* agents.get(Agent.ID.make("reviewer"))).toMatchObject({ system: "Review changes" })
        }),
    },
    {
      name: "created in a legacy modes directory",
      source: "modes",
      prepare: () => Effect.void,
      mutate: (directory: string) =>
        Effect.promise(async () => {
          const file = path.join(directory, "plan.md")
          await fs.writeFile(file, "Make a plan")
          return [{ type: "create" as const, path: file }]
        }),
      verify: (agents: Agent.Interface) =>
        Effect.gen(function* () {
          expect(yield* agents.get(Agent.ID.make("plan"))).toMatchObject({ system: "Make a plan", mode: "primary" })
        }),
    },
    {
      name: "updated",
      source: "agents",
      prepare: (directory: string) =>
        Effect.promise(() => fs.writeFile(path.join(directory, "reviewer.md"), "Review first")),
      mutate: (directory: string) =>
        Effect.promise(async () => {
          const file = path.join(directory, "reviewer.md")
          await fs.writeFile(file, "Review updated")
          return [{ type: "update" as const, path: file }]
        }),
      verify: (agents: Agent.Interface) =>
        Effect.gen(function* () {
          expect(yield* agents.get(Agent.ID.make("reviewer"))).toMatchObject({ system: "Review updated" })
        }),
    },
    {
      name: "renamed",
      source: "agents",
      prepare: (directory: string) =>
        Effect.promise(() => fs.writeFile(path.join(directory, "reviewer.md"), "Review renamed")),
      mutate: (directory: string) =>
        Effect.promise(async () => {
          const previous = path.join(directory, "reviewer.md")
          const next = path.join(directory, "release.md")
          await fs.rename(previous, next)
          return [
            { type: "delete" as const, path: previous },
            { type: "create" as const, path: next },
          ]
        }),
      verify: (agents: Agent.Interface) =>
        Effect.gen(function* () {
          expect(yield* agents.get(Agent.ID.make("reviewer"))).toBeUndefined()
          expect(yield* agents.get(Agent.ID.make("release"))).toMatchObject({ system: "Review renamed" })
        }),
    },
    {
      name: "deleted",
      source: "agents",
      prepare: (directory: string) =>
        Effect.promise(() => fs.writeFile(path.join(directory, "reviewer.md"), "Review deleted")),
      mutate: (directory: string) =>
        Effect.promise(async () => {
          const file = path.join(directory, "reviewer.md")
          await fs.unlink(file)
          return [{ type: "delete" as const, path: file }]
        }),
      verify: (agents: Agent.Interface) =>
        Effect.gen(function* () {
          expect(yield* agents.get(Agent.ID.make("reviewer"))).toBeUndefined()
        }),
    },
  ] as const
}
