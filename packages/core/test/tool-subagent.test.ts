import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { LanguageModel, type LLMRequest } from "@ocpp/ai"
import { OpenAIChat } from "@ocpp/ai/protocols"
import { TestLLM } from "@ocpp/ai/testing"
import path from "path"
import { Money } from "@ocpp/schema/money"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { LayerNodePlatform } from "@ocpp/core/effect/app-node-platform"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Global } from "@ocpp/util/global"
import { makeGlobalNode, makeLocationNode } from "@ocpp/util/effect/app-node"
import { Database } from "@ocpp/core/database/database"
import { Bus } from "@ocpp/core/bus"
import { Catalog } from "@ocpp/core/catalog"
import { CodeModeStore } from "@ocpp/core/codemode/store"
import { Config } from "@ocpp/core/config"
import { Location } from "@ocpp/core/location"
import { Model } from "@ocpp/core/model"
import { Provider } from "@ocpp/core/provider"
import { AbsolutePath } from "@ocpp/core/schema"
import { Agent } from "@ocpp/core/agent"
import { Job } from "@ocpp/core/job"
import { KV } from "@ocpp/core/kv"
import { LocationServiceMap } from "@ocpp/core/location-service-map"
import { Session } from "@ocpp/core/session"
import { SessionEvent } from "@ocpp/core/session/event"
import { SessionExecution } from "@ocpp/core/session/execution"
import { SessionRestart } from "@ocpp/core/session/execution/restart"
import { SessionInbox } from "@ocpp/core/session/inbox"
import { SessionMessage } from "@ocpp/core/session/message"
import { SessionRunnerModel } from "@ocpp/core/session/runner/model"
import { SessionStore } from "@ocpp/core/session/store"
import { PluginHooks } from "@ocpp/core/plugin/hooks"
import { PluginRuntime } from "@ocpp/core/plugin/runtime"
import { PluginSupervisor } from "@ocpp/core/plugin/supervisor"
import { Permission } from "@ocpp/core/permission"
import { SubagentTool } from "@ocpp/core/tool/plugin/subagent"
import { ExternalAgentDrivers } from "@ocpp/core/external-agent/drivers"
import { ExternalAgentSession } from "@ocpp/core/external-agent/session"
import { noVendorDrivers } from "./lib/drivers"
import { Tool } from "@ocpp/core/tool"
import { execute } from "@ocpp/core/tool/runtime"
import { tmpdir } from "./fixture/tmpdir"
import { tempGlobalLayer } from "./fixture/global"
import { testEffect } from "./lib/effect"
import {
  executeTool,
  readCodeModeNotebook,
  registerToolPlugin,
  registeredTools,
  seedToolSession,
  toolIdentity,
  waitForCodeMode,
} from "./lib/tool"

const childText = "child final response"
const completedOutput = (sessionID: Session.ID, message = childText) =>
  `<subagent sessionID="${sessionID}" state="completed">\n${message}\n</subagent>`
// Large enough that any model-visible rendering would have to truncate or omit it.
const secret = "secret-token-" + "x".repeat(4 * 1024)
const inputNotice = (value: unknown, shape: string) =>
  `Machine input for this call is ${shape} (${new TextEncoder().encode(JSON.stringify(value)).byteLength} bytes). It is not shown here; use it directly as input in execute programs, for example input or input.dataset.`
const childModel = Model.Ref.make({ id: Model.ID.make("child"), providerID: Provider.ID.make("test") })
const parentModel = Model.Ref.make({ id: Model.ID.make("parent"), providerID: Provider.ID.make("test") })
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

const outputSessionID = (value: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ sessionID: Session.ID }))(value).sessionID

const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const completed = new Set<Session.ID>()
      const complete = Effect.fn("SubagentTest.complete")(function* (sessionID: Session.ID) {
        if (completed.has(sessionID)) return
        if ((yield* store.get(sessionID))?.title?.includes("fail")) {
          yield* new SessionRunnerModel.ModelNotSelectedError({ sessionID })
          return
        }
        completed.add(sessionID)
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: Agent.ID.make("reviewer"),
          model: childModel,
        })
        yield* bus.publish(SessionEvent.Text.Started, {
          sessionID,
          assistantMessageID,
          ordinal: 0,
        })
        yield* bus.publish(SessionEvent.Text.Ended, {
          sessionID,
          assistantMessageID,
          ordinal: 0,
          text: childText,
        })
        yield* bus.publish(SessionEvent.Step.Ended, {
          sessionID,
          assistantMessageID,
          finish: "stop",
          cost: Money.USD.zero,
          tokens,
        })
      })
      return SessionExecution.Service.of({
        active: Effect.succeed(new Set()),
        isActive: () => Effect.succeed(false),
        resume: complete,
        wake: () => Effect.void,
        interrupt: () => Effect.succeed(false),
        awaitIdle: (sessionID) => complete(sessionID).pipe(Effect.exit, Effect.asVoid),
      })
    }),
  ),
  deps: [Bus.node, SessionStore.node],
})

const subagentPluginSupervisor = makeLocationNode({
  service: PluginSupervisor.Service,
  layer: Layer.effect(
    PluginSupervisor.Service,
    registerToolPlugin(SubagentTool.Plugin).pipe(Effect.as(PluginSupervisor.Service.of({ flush: Effect.void }))),
  ),
  deps: [
    Agent.node,
    Bus.node,
    Catalog.node,
    Config.node,
    ExternalAgentDrivers.node,
    ExternalAgentSession.node,
    Permission.node,
    PluginHooks.node,
    PluginRuntime.node,
    Tool.node,
  ],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  CodeModeStore.node,
  Job.node,
  Session.node,
  SessionExecution.node,
  PluginRuntime.providerNode,
  LocationServiceMap.node,
])
const replacements = [
  [SessionExecution.node, executionNode],
  [Global.node, tempGlobalLayer],
  [ExternalAgentDrivers.node, noVendorDrivers],
] satisfies LayerNode.Replacements
const productionIt = testEffect(AppNodeBuilder.build(nodes, replacements))
const it = testEffect(AppNodeBuilder.build(nodes, [...replacements, [PluginSupervisor.node, subagentPluginSupervisor]]))
const resolvedChildModel = Layer.succeed(SessionRunnerModel.Service, {
  resolve: () =>
    Effect.succeed(
      SessionRunnerModel.resolved(LanguageModel.make({ id: "child", provider: "test", route: OpenAIChat.route }), {
        capabilities: { tools: true, input: ["text"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 32_000 },
      }),
    ),
})
const completionIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([nodes, SessionRestart.node, KV.node]), [
    [Global.node, tempGlobalLayer],
    [PluginSupervisor.node, subagentPluginSupervisor],
    [ExternalAgentDrivers.node, noVendorDrivers],
    [
      LayerNodePlatform.llmClient,
      TestLLM.testLayer({
        fallback: TestLLM.tool("call-submit", "execute", {
          code: [
            "const total = input.values.reduce((sum, value) => sum + value, 0)",
            'return tools.submit_result({ message: "The total is " + total, output: { answer: total, noteLength: input.note.length } })',
          ].join("\n"),
        }),
      }),
    ],
    [SessionRunnerModel.node, resolvedChildModel],
  ]),
)
// Model requests the real runner sends, so a test can read exactly what the model is shown.
const modelRequests: LLMRequest[] = []
const requestIt = testEffect(
  AppNodeBuilder.build(LayerNode.group([nodes, SessionRestart.node, KV.node]), [
    [Global.node, tempGlobalLayer],
    [PluginSupervisor.node, subagentPluginSupervisor],
    [ExternalAgentDrivers.node, noVendorDrivers],
    [
      LayerNodePlatform.llmClient,
      TestLLM.testLayer({
        fallback: TestLLM.text("Done.", "text-done"),
        transformRequest: (request) => {
          modelRequests.push(request)
          return request
        },
      }),
    ],
    [SessionRunnerModel.node, resolvedChildModel],
  ]),
)

const withSubagent = (location: Location.Ref) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    yield* PluginSupervisor.Service.use((supervisor) => supervisor.flush).pipe(Effect.provide(locations.get(location)))
    yield* Catalog.Service.use((catalog) =>
      catalog.transform((draft) => {
        draft.model.update(Provider.ID.make("test"), Model.ID.make("child"), () => {})
        draft.model.update(Provider.ID.make("test"), Model.ID.make("parent"), () => {})
        draft.model.update(Provider.ID.make("test"), Model.ID.make("override"), (model) => {
          model.variants.push({ id: Model.VariantID.make("high") })
        })
      }),
    ).pipe(Effect.provide(locations.get(location)))
    yield* Agent.Service.use((agents) =>
      agents.transform((draft) => {
        // The caller identity used by executeTool; subagent permission asserts against it.
        draft.update(toolIdentity.agent, (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
        })
        draft.update(Agent.ID.make("reviewer"), (agent) => {
          agent.mode = "subagent"
          agent.model = childModel
        })
        draft.update(Agent.ID.make("fallback"), (agent) => {
          agent.mode = "subagent"
        })
        draft.update(Agent.ID.make("primary"), (agent) => {
          agent.mode = "primary"
        })
      }),
    ).pipe(Effect.provide(locations.get(location)))
  })

// Beside withSubagent's agents: a described subagent, a hidden one, and one the caller's rules deny.
const withListedSubagents = (location: Location.Ref) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    yield* Agent.Service.use((agents) =>
      agents.transform((draft) => {
        draft.update(Agent.ID.make("reviewer"), (agent) => {
          agent.description = "Reviews changes for correctness."
        })
        draft.update(Agent.ID.make("hidden"), (agent) => {
          agent.mode = "subagent"
          agent.hidden = true
        })
        draft.update(Agent.ID.make("blocked"), (agent) => {
          agent.mode = "subagent"
        })
        draft.update(toolIdentity.agent, (agent) => {
          agent.permissions.push({ action: SubagentTool.name, resource: "blocked", effect: "deny" })
        })
      }),
    ).pipe(Effect.provide(locations.get(location)))
  })

// Primary, hidden, and denied agents are left out.
const listedSubagents = [
  "Available subagents:",
  "- fallback: This subagent should only be called when explicitly requested.",
  "- reviewer: Reviews changes for correctness.",
]

describe("SubagentTool", () => {
  it.live("appends the subagents the caller may start to the description tools.search returns", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location })
          yield* withSubagent(parent.location)
          yield* withListedSubagents(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const caller = yield* Agent.Service.use((agents) => agents.get(toolIdentity.agent)).pipe(
            Effect.provide(locations.get(parent.location)),
          )
          const described = [
            SubagentTool.description,
            "",
            ...listedSubagents,
            "",
            "Drivers (the default is the calling session's driver):",
            "- ocpp: the OC++ runner with a provider model",
            "- claude: Claude Code is not available on this machine",
            "- codex: Codex is not available on this machine",
            "- pi: Pi is not available on this machine",
          ].join("\n")
          const subagentEntry = (snapshot: Tool.Snapshot) =>
            snapshot.codeModeCatalog?.find((tool) => tool.path === SubagentTool.name)?.description

          const snapshot = yield* registry.snapshot(caller?.permissions, parent.id, { agent: toolIdentity.agent })
          expect(subagentEntry(snapshot)).toBe(described)
          // Without a caller there is nothing to filter for, so the description stays generic.
          expect(subagentEntry(yield* registry.snapshot())).toBe(SubagentTool.description)

          yield* seedToolSession(parent.id, toolIdentity.messageID)
          const started = yield* snapshot.execute({
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-search-subagent",
              name: "execute",
              input: { code: 'const subagentSearch = tools.search({ query: "tools.subagent" })' },
            },
          })
          expect(
            yield* waitForCodeMode(started.output, {
              sessionID: parent.id,
              assistantMessageID: toolIdentity.messageID,
              id: "call-search-subagent",
            }),
          ).toMatchObject({ status: "saved", saved: ["subagentSearch"] })
          expect((yield* readCodeModeNotebook(parent.id)).subagentSearch).toMatchObject({
            items: [{ path: "tools.subagent", description: described }],
          })
        }),
      ),
    ),
  )

  requestIt.live("shows the model the subagents it may start before it searches", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          yield* withListedSubagents(parent.location)
          modelRequests.length = 0

          yield* sessions.prompt({ sessionID: parent.id, text: "Who can review this change?", resume: false })
          yield* sessions.resume(parent.id)

          const system = modelRequests[0]?.system.map((part) => part.text).join("\n") ?? ""
          expect(system).toContain(
            [
              "Subagents work on a task in a child session. Start one with `tools.subagent`, passing one of these IDs as `agent`.",
              ...listedSubagents,
            ].join("\n"),
          )
          expect(system).toContain("  - tools.subagent(input: {")
        }),
      ),
    ),
  )

  productionIt.live("registers globally while resolving agents from the caller location", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const session = yield* Session.Service
          const parent = yield* session.create({ location })
          yield* withSubagent(parent.location)

          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const snapshot = yield* registry.snapshot()
          expect(snapshot.definitions.map((tool) => tool.name)).toEqual(["execute"])
          expect(snapshot.codeModeCatalog?.map((tool) => tool.path)).toContain(SubagentTool.name)
          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-primary",
                name: SubagentTool.name,
                input: { agent: "primary", description: "primary", message: "should fail" },
              },
            }),
          ).toEqual({
            status: "error",
            error: { type: "tool.execution", message: "Agent primary cannot run as a subagent" },
          })
        }),
      ),
    ),
  )

  it.live("prevents subagents from launching subagents by default", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const root = yield* sessions.create({ location })
          const parent = yield* sessions.create({ parentID: root.id, title: "parent" })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-nested-subagent",
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "nested", message: "should fail" },
              },
            }),
          ).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: expect.stringContaining("Subagent depth limit reached (1)"),
            },
          })
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(0)
        }),
      ),
    ),
  )

  it.live("allows nested subagents up to the configured depth", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Bun.write(path.join(dir.path, "ocpp.json"), JSON.stringify({ experimental: { subagent_depth: 2 } })),
          )
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const root = yield* sessions.create({ location })
          const parent = yield* sessions.create({ parentID: root.id, title: "parent", model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-configured-nested-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "nested", message: "should run" },
            },
          })

          expect(settled).toMatchObject({
            status: "completed",
            metadata: { status: "completed" },
            content: [{ type: "text", text: expect.stringContaining(childText) }],
          })
          expect(settled.metadata).toEqual({
            sessionID: outputSessionID(settled.metadata),
            status: "completed",
          })
          expect((yield* sessions.get(outputSessionID(settled.metadata))).parentID).toBe(parent.id)
        }),
      ),
    ),
  )

  it.live("runs a foreground child session and returns the final assistant text", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const progress: Tool.Metadata[] = []

          expect((yield* registry.snapshot()).codeModeCatalog?.map((tool) => tool.path)).toContain("subagent.models")
          yield* seedToolSession(parent.id, toolIdentity.messageID)
          const listed = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-models",
              name: "execute",
              input: { code: "const availableModels = tools.subagent.models({})" },
            },
          })
          expect(listed.status).toBe("completed")
          expect(
            yield* waitForCodeMode(listed.output, {
              sessionID: parent.id,
              assistantMessageID: toolIdentity.messageID,
              id: "call-subagent-models",
            }),
          ).toMatchObject({ status: "saved", saved: ["availableModels"] })
          expect((yield* readCodeModeNotebook(parent.id)).availableModels).toMatchObject({
            models: [
              { id: "test/child", variants: [] },
              { id: "test/parent", variants: [] },
              { id: "test/override", variants: ["high"] },
            ],
            drivers: [
              { id: "claude", name: "Claude Code", available: false, model: "sonnet" },
              { id: "codex", name: "Codex", available: false, model: "gpt-5.6-sol" },
              { id: "pi", name: "Pi", available: false },
            ],
          })

          const unsupported = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-unsupported-model",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "review",
                message: "review this",
                model: "test/overide#hgh",
              },
            },
          })
          expect(unsupported).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message:
                "Unsupported subagent model: test/overide#hgh. Try one of: test/override#high, test/override, test/child. Query all available models with tools.subagent.models({}).",
            },
          })
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(0)

          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            progress: (update) => Effect.sync(() => progress.push(update)),
            call: {
              type: "tool-call",
              id: "call-subagent",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "review", message: "review this" },
            },
          })

          expect(settled).toMatchObject({
            status: "completed",
            metadata: { status: "completed" },
            content: [{ type: "text", text: expect.stringContaining(childText) }],
          })
          const child = yield* sessions.get(outputSessionID(settled.metadata))
          expect(settled.content).toEqual([{ type: "text", text: completedOutput(child.id) }])
          expect(settled.metadata).toEqual({ sessionID: child.id, status: "completed" })
          expect(progress[0]).toEqual({ sessionID: child.id, status: "running" })
          expect(child).toMatchObject({
            parentID: parent.id,
            location: parent.location,
            agent: "reviewer",
            model: childModel,
          })
          expect((yield* sessions.inbox(child.id)).find((message) => message.type === "user")?.payload.text).toBe(
            "You are a subagent spawned by another session.\nreview this",
          )

          const fallback = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-fallback",
              name: SubagentTool.name,
              input: { agent: "fallback", description: "fallback", message: "fallback" },
            },
          })
          const fallbackChild = yield* sessions.get(outputSessionID(fallback.metadata))
          expect(fallbackChild).toMatchObject({ parentID: parent.id, model: parentModel })
        }),
      ),
    ),
  )

  it.live("continues an existing child session", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          const first = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-first",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "review", message: "review this" },
            },
          })
          const childID = outputSessionID(first.metadata)
          const second = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-second",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "follow up",
                message: "continue this",
                sessionID: childID,
                model: "test/override#high",
              },
            },
          })

          expect(outputSessionID(second.metadata)).toBe(childID)
          expect((yield* sessions.get(childID)).model).toEqual(
            Model.Ref.make({
              providerID: Provider.ID.make("test"),
              id: Model.ID.make("override"),
              variant: Model.VariantID.make("high"),
            }),
          )
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(1)
          expect((yield* sessions.get(childID)).title).toBe("review")
          expect(
            (yield* sessions.inbox(childID)).flatMap((message) =>
              message.type === "user" ? [message.payload.text] : [],
            ),
          ).toEqual(["You are a subagent spawned by another session.\nreview this", "continue this"])
          expect(second.content).toEqual([{ type: "text", text: completedOutput(childID) }])
        }),
      ),
    ),
  )

  it.live("rejects unrelated children and switches agents on continuation", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          const otherParent = yield* sessions.create({ location, model: parentModel })
          const unrelated = yield* sessions.create({
            parentID: otherParent.id,
            title: "other review",
            agent: Agent.ID.make("reviewer"),
          })
          const switched = yield* sessions.create({
            parentID: parent.id,
            title: "fallback review",
            agent: Agent.ID.make("fallback"),
            model: parentModel,
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const call = (sessionID: Session.ID, id: string, agent = "reviewer") =>
            executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call" as const,
                id,
                name: SubagentTool.name,
                input: { agent, description: "follow up", message: "continue", sessionID },
              },
            })

          const missing = Session.ID.create()
          expect(yield* call(missing, "call-missing-child")).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: `Subagent session not found: ${missing}`,
            },
          })
          expect(yield* call(unrelated.id, "call-unrelated-child")).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: `Session ${unrelated.id} is not a child of the current session`,
            },
          })
          expect(yield* call(switched.id, "call-switched-child")).toMatchObject({
            status: "completed",
            metadata: { sessionID: switched.id, status: "completed" },
          })
          expect(yield* sessions.get(switched.id)).toMatchObject({
            agent: "reviewer",
            model: childModel,
          })
          // Switching to an agent without a configured model keeps the child's current model.
          expect(yield* call(switched.id, "call-modelless-switch", "fallback")).toMatchObject({
            status: "completed",
            metadata: { sessionID: switched.id, status: "completed" },
          })
          expect(yield* sessions.get(switched.id)).toMatchObject({
            agent: "fallback",
            model: childModel,
          })
        }),
      ),
    ),
  )

  it.live("returns child runner failures as tool errors", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-subagent-failure",
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "fail review", message: "please fail" },
              },
            }),
          ).toEqual({
            status: "error",
            error: {
              type: "provider.no-route",
              message: expect.stringContaining("No model is available for session"),
            },
          })
        }),
      ),
    ),
  )

  it.live("disposes the child registration when a structured run fails", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))

          // A structured call registers submit_result and machine input for the child. The run's
          // `ensuring` owns that registration, so a failing run must leave nothing live behind.
          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-structured-failure",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "fail review",
                message: "please fail",
                input: { dataset: [1] },
                outputSchema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
              },
            },
          })
          expect(settled.status).toBe("error")
          const children = (yield* sessions.list({ parentID: parent.id })).data
          expect(children).toHaveLength(1)
          expect(
            (yield* registry.snapshot(undefined, children[0].id)).codeModeCatalog?.map((tool) => tool.path),
          ).not.toContain("submit_result")
        }),
      ),
    ),
  )

  it.live("exposes invocation input directly without rendering it to either model", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const call = (id: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: { type: "tool-call" as const, id, name: SubagentTool.name, input },
            })

          const first = { dataset: [1, 2, 3], note: secret }
          const settled = yield* call("call-subagent-input", {
            agent: "reviewer",
            description: "analyze",
            message: "Analyze the dataset",
            input: first,
            inputSchema: { type: "object", required: ["dataset"] },
          })
          const childID = outputSessionID(settled.metadata)
          expect(settled).toEqual({
            status: "completed",
            output: { sessionID: childID, status: "completed", message: childText, output: null },
            content: [{ type: "text", text: completedOutput(childID) }],
            metadata: { sessionID: childID, status: "completed" },
          })
          const prompts = () =>
            sessions
              .inbox(childID)
              .pipe(Effect.map((items) => items.flatMap((item) => (item.type === "user" ? [item.payload.text] : []))))
          expect(yield* prompts()).toEqual([
            [
              "You are a subagent spawned by another session.",
              inputNotice(first, "a record with keys dataset, note"),
              "Analyze the dataset",
            ].join("\n"),
          ])
          expect(JSON.stringify(yield* prompts())).not.toContain("secret-token")

          // Every continuation may carry invocation-local input for that call.
          expect(
            yield* call("call-subagent-again", {
              agent: "reviewer",
              description: "again",
              message: "Use the new data",
              input: { dataset: [4] },
              sessionID: childID,
            }),
          ).toMatchObject({ status: "completed", metadata: { sessionID: childID } })
          expect(
            yield* call("call-subagent-third", {
              agent: "reviewer",
              description: "third",
              message: "Use the list",
              input: [5, 6],
              sessionID: childID,
            }),
          ).toMatchObject({ status: "completed", metadata: { sessionID: childID } })
          expect((yield* prompts()).slice(1)).toEqual([
            [inputNotice({ dataset: [4] }, "a record with keys dataset"), "Use the new data"].join("\n"),
            [inputNotice([5, 6], "an array of 2 items"), "Use the list"].join("\n"),
          ])
        }),
      ),
    ),
  )

  it.live("refuses input that violates inputSchema before any session exists", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const failure = (id: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call" as const,
                id,
                name: SubagentTool.name,
                input: { agent: "reviewer", description: "invalid", message: "should fail", ...input },
              },
            }).pipe(Effect.map((settled) => settled.error?.message ?? settled.status))

          expect(
            yield* failure("call-input-schema", {
              input: { dataset: "text" },
              inputSchema: { type: "object", properties: { dataset: { type: "array" } }, required: ["dataset"] },
            }),
          ).toContain("Subagent input does not match inputSchema")
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(0)
        }),
      ),
    ),
  )

  it.live("passes notebook values by reference from a Code Mode parent and retains the full result", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          yield* seedToolSession(parent.id, toolIdentity.messageID)
          const run = (id: string, code: string) =>
            Effect.gen(function* () {
              const started = yield* executeTool(registry, {
                sessionID: parent.id,
                ...toolIdentity,
                call: { type: "tool-call" as const, id, name: "execute", input: { code } },
              })
              expect(started.status).toBe("completed")
              return yield* waitForCodeMode(started.output, {
                sessionID: parent.id,
                assistantMessageID: toolIdentity.messageID,
                id,
              })
            })

          expect(
            yield* run("call-dataset", `const dataset = [1, 2, 3]\nconst note = ${JSON.stringify(secret)}`),
          ).toMatchObject({ status: "saved", saved: ["dataset", "note"] })
          const delegated = yield* run(
            "call-delegate",
            'const review = tools.subagent({ agent: "reviewer", description: "analyze", message: "Analyze the dataset", input: { dataset, note } })',
          )
          expect(delegated).toMatchObject({ status: "saved", saved: ["review"] })
          expect(delegated.summary).not.toContain("secret-token")

          const notebook = yield* readCodeModeNotebook(parent.id)
          const childID = outputSessionID(notebook.review)
          expect(notebook.review).toEqual({ sessionID: childID, status: "completed", message: childText, output: null })
          expect((yield* sessions.get(childID)).parentID).toBe(parent.id)
          expect(
            (yield* sessions.inbox(childID)).flatMap((item) => (item.type === "user" ? [item.payload.text] : [])),
          ).toEqual([
            [
              "You are a subagent spawned by another session.",
              inputNotice({ dataset: [1, 2, 3], note: secret }, "a record with keys dataset, note"),
              "Analyze the dataset",
            ].join("\n"),
          ])
        }),
      ),
    ),
  )

  completionIt.live("returns a structured submission as message plus machine output", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const settled = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-structured-subagent",
              name: SubagentTool.name,
              input: {
                agent: "reviewer",
                description: "structured review",
                message: "Add up the values",
                input: { values: [40, 2], note: secret },
                outputSchema: {
                  type: "object",
                  properties: { answer: { type: "number" }, noteLength: { type: "number" } },
                  required: ["answer", "noteLength"],
                  additionalProperties: false,
                },
              },
            },
          })

          // The child's program received the whole value as machine output, so it could compute over
          // both fields, while neither model saw the value itself.
          const childID = outputSessionID(settled.metadata)
          const output = { answer: 42, noteLength: secret.length }
          expect(settled).toEqual({
            status: "completed",
            output: { sessionID: childID, status: "completed", message: "The total is 42", output },
            content: [{ type: "text", text: completedOutput(childID, "The total is 42") }],
            metadata: {
              sessionID: childID,
              status: "completed",
              output: { type: "object", keys: ["answer", "noteLength"], bytes: JSON.stringify(output).length },
            },
          })
          const delivered = yield* sessions.messages({ sessionID: childID, order: "asc" })
          expect(delivered.flatMap((message) => (message.type === "user" ? [message.text] : []))).toEqual([
            expect.stringContaining(inputNotice({ values: [40, 2], note: secret }, "a record with keys values, note")),
          ])
          expect(JSON.stringify(delivered)).not.toContain("secret-token")
          expect(JSON.stringify(delivered)).not.toContain("[40,2]")
          // The submitting execution settled before the child was stopped, so its top-level
          // declaration computed from input is durable in the child's notebook. A cancellation
          // would have discarded it and delivered an extra notification (asserted absent above).
          expect((yield* readCodeModeNotebook(childID)).total).toBe(42)
          expect(
            (yield* registry.snapshot(undefined, childID)).codeModeCatalog?.map((tool) => tool.path),
          ).not.toContain("submit_result")
        }),
      ),
    ),
  )

  it.live("classifies failures after the child exists with a structured reason", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const subagent = (yield* registeredTools(registry)).get(SubagentTool.name)
          if (!subagent) return yield* Effect.die("subagent is not registered")
          const fail = (id: string, input: Record<string, unknown>) =>
            execute(subagent, input, {
              sessionID: parent.id,
              ...toolIdentity,
              id: Tool.CallID.make(id),
              progress: () => Effect.void,
            }).pipe(Effect.flip)

          // The child's own run fails: the runner error stays the message, the reason is data.
          const crashed = yield* fail("call-reason-child-failed", {
            agent: "reviewer",
            description: "fail review",
            message: "please fail",
          })
          expect(crashed.metadata).toEqual({
            sessionID: expect.stringMatching(/^ses_/),
            status: "error",
            reason: "child-failed",
          })

          // A structured child that answers in text twice is reminded once and then reported,
          // without a second repair attempt.
          const silent = yield* fail("call-reason-no-submission", {
            agent: "reviewer",
            description: "structured review",
            message: "Add up the values",
            outputSchema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
          })
          expect(silent.message).toMatch(/^Subagent did not submit a structured result/)
          expect(silent.metadata).toEqual({
            sessionID: expect.stringMatching(/^ses_/),
            status: "error",
            reason: "no-submission",
          })
          const childID = Schema.decodeUnknownSync(Schema.Struct({ sessionID: Session.ID }))(silent.metadata).sessionID
          // The stubbed runner never delivers, so both prompts remain admitted in the child's inbox.
          const prompts = (yield* sessions.inbox(childID)).flatMap((item) =>
            item.type === "user" ? [item.payload.text] : [],
          )
          expect(prompts).toHaveLength(2)
          expect(prompts[1]).toBe(
            "You did not submit the required result. Call tools.submit_result now with { message, output }, where output matches the requested schema.",
          )
        }),
      ),
    ),
  )
})
