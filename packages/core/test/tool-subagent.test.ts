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
import { FSUtil } from "@ocpp/util/fs-util"
import { Global } from "@ocpp/util/global"
import { makeGlobalNode, makeLocationNode } from "@ocpp/util/effect/app-node"
import { Database } from "@ocpp/core/database/database"
import { Bus } from "@ocpp/core/bus"
import { Catalog } from "@ocpp/core/catalog"
import { CodeModeChildren } from "@ocpp/core/codemode/children"
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
    FSUtil.node,
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
        // The caller identity used by executeTool.
        draft.update(toolIdentity.agent, (agent) => {
          agent.mode = "primary"
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

// Beside withSubagent's agents: a described subagent and a hidden one.
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
      }),
    ).pipe(Effect.provide(locations.get(location)))
  })

// Primary and hidden agents are left out.
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
          const described = [
            SubagentTool.description,
            "",
            // No vendor driver is ready here, so none is offered.
            ...listedSubagents,
          ].join("\n")
          const subagentEntry = (snapshot: Tool.Snapshot) =>
            snapshot.codeModeCatalog?.find((tool) => tool.path === SubagentTool.name)?.description

          const snapshot = yield* registry.snapshot(undefined, parent.id, { agent: toolIdentity.agent })
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
              "Subagents work on a task in a child session. Start one with `tools.subagent`, passing one of these IDs as `agent` and the child's tools as `tools`.",
              "An agent is a prompt and model preset; it grants no tools. The child can call exactly the tools you pass: your own tools such as tools.read, whole namespaces such as tools.linear, and tool.define handles. Without `tools` it has none, only tools.submit_result when you pass an outputSchema.",
              "Pass `root` to run one in another existing directory, such as a separate git worktree.",
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
              { id: "codex", name: "Codex", available: false, model: "sol" },
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
          // Reported once the child exists, then again once it holds its task.
          expect(progress.slice(0, 2)).toEqual([
            { sessionID: child.id, status: "starting" },
            { sessionID: child.id, status: "running" },
          ])
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

  it.live("continues a child with only sessionID and message, keeping its agent, title and model", () =>
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
              id: "call-subagent-minimal-first",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "review", message: "review this" },
            },
          })
          const childID = outputSessionID(first.metadata)
          const before = yield* sessions.get(childID)
          const second = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-minimal-second",
              name: SubagentTool.name,
              input: { sessionID: childID, message: "continue this" },
            },
          })

          expect(second).toMatchObject({ status: "completed", metadata: { sessionID: childID, status: "completed" } })
          expect(yield* sessions.get(childID)).toMatchObject({
            agent: "reviewer",
            title: "review",
            model: before.model,
          })
          expect(before.model).toMatchObject(childModel)
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(1)
          expect(
            (yield* sessions.inbox(childID)).flatMap((message) =>
              message.type === "user" ? [message.payload.text] : [],
            ),
          ).toEqual(["You are a subagent spawned by another session.\nreview this", "continue this"])
        }),
      ),
    ),
  )

  it.live("requires agent and description to start a new child and creates none without them", () =>
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
              call: { type: "tool-call" as const, id, name: SubagentTool.name, input: { message: "work", ...input } },
            })
          const required = {
            status: "error" as const,
            error: {
              type: "tool.execution" as const,
              message:
                "agent and description are required to start a new subagent. To continue a previous subagent, pass its sessionID.",
            },
          }

          expect(yield* call("call-new-bare", {})).toEqual(required)
          expect(yield* call("call-new-no-description", { agent: "reviewer" })).toEqual(required)
          expect(yield* call("call-new-no-agent", { description: "review" })).toEqual(required)
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(0)
        }),
      ),
    ),
  )

  it.live("reads an own child's transcript without tool metadata and pages older messages", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const bus = yield* Bus.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          const otherParent = yield* sessions.create({ location, model: parentModel })
          const unrelated = yield* sessions.create({
            parentID: otherParent.id,
            title: "other review",
            agent: Agent.ID.make("reviewer"),
          })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          expect((yield* registry.snapshot()).codeModeCatalog?.map((tool) => tool.path)).toContain(
            "subagent.transcript",
          )

          const first = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-transcript-child",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "review", message: "review this" },
            },
          })
          const childID = outputSessionID(first.metadata)
          // The test runner answers without delivering the prompt, so deliver it here.
          yield* SessionInbox.promote((yield* Database.Service).db, bus, childID, "input")
          // A later step that ran a Code Mode execution whose metadata carries private data.
          const assistantMessageID = SessionMessage.ID.create()
          const base = { sessionID: childID, assistantMessageID, id: "call-child-execute" }
          yield* bus.publish(SessionEvent.Step.Started, {
            sessionID: childID,
            assistantMessageID,
            agent: Agent.ID.make("reviewer"),
            model: childModel,
          })
          yield* bus.publish(SessionEvent.Tool.Input.Started, { ...base, name: "execute" })
          yield* bus.publish(SessionEvent.Tool.Input.Ended, { ...base, text: JSON.stringify({ code: "return 1" }) })
          yield* bus.publish(SessionEvent.Tool.Called, { ...base, input: { code: "return 1" }, executed: true })
          yield* bus.publish(SessionEvent.Tool.Success, {
            ...base,
            content: [{ type: "text", text: "Preview: 1" }],
            metadata: { executionID: "exe_secret", events: [{ input: secret }] },
            executed: true,
          })
          yield* bus.publish(SessionEvent.Step.Ended, {
            sessionID: childID,
            assistantMessageID,
            finish: "stop",
            cost: Money.USD.zero,
            tokens,
          })

          const transcript = (id: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: { type: "tool-call" as const, id, name: "subagent_transcript", input },
            })
          const read = (id: string, input: Record<string, unknown>) =>
            transcript(id, input).pipe(
              Effect.map((result) => {
                if (result.status !== "completed") throw new Error(JSON.stringify(result))
                return { ...result, output: Schema.decodeUnknownSync(SubagentTool.TranscriptOutput)(result.output) }
              }),
            )

          const plain = yield* read("call-transcript-plain", { sessionID: childID })
          expect(plain.output).toMatchObject({ sessionID: childID, title: "review", agent: "reviewer" })
          expect(plain.output.cursor).toBeUndefined()
          // Without include, the tool-only step has nothing to show.
          expect(plain.output.messages.map((message) => [message.role, message.text])).toEqual([
            ["assistant", childText],
            ["user", "You are a subagent spawned by another session.\nreview this"],
          ])
          expect(JSON.stringify(plain.content)).toContain("BEGIN_UNTRUSTED_EXECUTION_DATA")

          const full = yield* read("call-transcript-tools", { sessionID: childID, include: ["tools"] })
          expect(full.output.messages.at(-1)).toEqual({
            id: assistantMessageID,
            role: "assistant",
            text: "",
            tools: [{ name: "execute", status: "completed", input: "return 1", result: "Preview: 1" }],
          })
          expect(JSON.stringify(full)).not.toContain("secret-token")
          expect(JSON.stringify(full)).not.toContain("exe_secret")

          // Paging one stored message at a time yields the same transcript, newest page first.
          const paged: (typeof full.output.messages)[number][][] = []
          let cursor: string | undefined
          for (let page = 0; page < 20; page++) {
            const next = yield* read(`call-transcript-page-${page}`, {
              sessionID: childID,
              include: ["tools"],
              limit: 1,
              ...(cursor === undefined ? {} : { cursor }),
            })
            paged.push([...next.output.messages])
            cursor = next.output.cursor
            if (cursor === undefined) break
          }
          expect(cursor).toBeUndefined()
          expect(paged.length).toBeGreaterThan(2)
          expect(paged.toReversed().flat()).toEqual([...full.output.messages])

          expect(yield* transcript("call-transcript-unrelated", { sessionID: unrelated.id })).toEqual({
            status: "error",
            error: {
              type: "tool.execution",
              message: `Session ${unrelated.id} is not a descendant of the current session`,
            },
          })
          const missing = Session.ID.create()
          expect(yield* transcript("call-transcript-missing", { sessionID: missing })).toEqual({
            status: "error",
            error: { type: "tool.execution", message: `Subagent session not found: ${missing}` },
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
            'const review = tools.subagent({ agent: "reviewer", description: "analyze", message: "Analyze the dataset", input: { dataset, note } }).wait()',
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

  it.live("resolves several subagents with Promise.all from one Code Mode program", () =>
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
          const id = "call-parallel"
          const started = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call" as const,
              id,
              name: "execute",
              input: {
                code: [
                  'let runs = ["first", "second"].map((name) => tools.subagent({ agent: "reviewer", description: "review " + name, message: "Review " + name }))',
                  "const reviews = await Promise.all(runs)",
                ].join("\n"),
              },
            },
          })
          expect(started.status).toBe("completed")
          const settled = yield* waitForCodeMode(started.output, {
            sessionID: parent.id,
            assistantMessageID: toolIdentity.messageID,
            id,
          })
          expect(settled).toMatchObject({ status: "saved", saved: ["reviews"] })

          const notebook = yield* readCodeModeNotebook(parent.id)
          const reviews = notebook.reviews as Array<unknown>
          expect(reviews).toHaveLength(2)
          const children = reviews.map(outputSessionID)
          expect(new Set(children).size).toBe(2)
          for (const [index, review] of reviews.entries())
            expect(review).toEqual({
              sessionID: children[index],
              status: "completed",
              message: childText,
              output: null,
            })
          expect((yield* sessions.list({ parentID: parent.id })).data.map((item) => item.id).sort()).toEqual(
            [...children].sort(),
          )
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

  it.live("reports a new child as soon as it exists and names it in failures before it holds its task", () =>
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
          const reported: unknown[] = []
          // Another registration takes the new child's machine input as soon as the child is reported, so
          // registering this call's input fails after the create and before the child receives its task.
          const failed = yield* execute(
            subagent,
            { agent: "reviewer", description: "review", message: "review this", input: { value: 1 } },
            {
              sessionID: parent.id,
              ...toolIdentity,
              id: Tool.CallID.make("call-subagent-setup-failed"),
              progress: (update) => {
                reported.push(update)
                const value = update as { readonly sessionID?: Session.ID; readonly status?: string }
                return value.status === "starting" && value.sessionID !== undefined
                  ? registry.registerSession(value.sessionID, [], { input: 0 }).pipe(Effect.orDie, Effect.asVoid)
                  : Effect.void
              },
            },
          ).pipe(Effect.flip)
          const children = (yield* sessions.list({ parentID: parent.id })).data
          expect(children).toHaveLength(1)
          const childID = children[0]!.id
          expect(reported).toEqual([{ sessionID: childID, status: "starting" }])
          expect(failed.message).toMatch(/^Invalid subagent tool: Machine input is already registered/)
          expect(failed.metadata).toEqual({ sessionID: childID, status: "error", reason: "setup-failed" })
        }),
      ),
    ),
  )

  it.live("after a restart gives an empty starting child its task and rejoins one that already holds it", () =>
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
          const prompt = "You are a subagent spawned by another session.\nreview this"
          const recover = (id: string, sessionID: Session.ID, input: Record<string, unknown> = {}) =>
            execute(
              subagent,
              { agent: "reviewer", description: "review", message: "review this", ...input },
              {
                sessionID: parent.id,
                ...toolIdentity,
                id: Tool.CallID.make(id),
                progress: () => Effect.void,
                recovered: { sessionID, status: "starting" },
              },
            )
          const prompts = (sessionID: Session.ID) =>
            sessions
              .inbox(sessionID)
              .pipe(Effect.map((items) => items.flatMap((item) => (item.type === "user" ? [item.payload.text] : []))))

          // Created before the restart but never given its task: this call gives it the task as a new child.
          const empty = yield* sessions.create({
            parentID: parent.id,
            title: "review",
            agent: Agent.ID.make("reviewer"),
          })
          const adopted = yield* recover("call-subagent-adopt", empty.id)
          expect(adopted.metadata).toMatchObject({ sessionID: empty.id, status: "completed" })
          expect(yield* prompts(empty.id)).toEqual([prompt])

          // Admitted its task just before the restart: rejoined and told to continue, never prompted twice.
          const held = yield* sessions.create({
            parentID: parent.id,
            title: "review",
            agent: Agent.ID.make("reviewer"),
          })
          yield* sessions.prompt({ sessionID: held.id, text: prompt, resume: false })
          const rejoined = yield* recover("call-subagent-rejoin", held.id)
          expect(rejoined.metadata).toMatchObject({ sessionID: held.id, status: "completed" })
          expect(yield* prompts(held.id)).toEqual([prompt])
          expect(JSON.stringify(yield* sessions.inbox(held.id))).toContain("The server restarted while you were working")

          // Neither recovery created another child.
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(2)

          // A continued child's history cannot show whether the message arrived, so the call fails and names it.
          const refused = yield* recover("call-subagent-refuse", held.id, { sessionID: held.id }).pipe(Effect.flip)
          expect(refused.message).toContain(`continuing subagent session ${held.id}, which may or may not have received`)
          expect(refused.metadata).toEqual({ sessionID: held.id, status: "error", reason: "setup-failed" })
          expect(yield* prompts(held.id)).toEqual([prompt])
        }),
      ),
    ),
  )

  it.live("reads any descendant's transcript, counts returned entries and bounds the records it scans", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const bus = yield* Bus.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const first = yield* executeTool(registry, {
            sessionID: parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "call-subagent-transcript-bounded",
              name: SubagentTool.name,
              input: { agent: "reviewer", description: "review", message: "review this" },
            },
          })
          const childID = outputSessionID(first.metadata)
          yield* SessionInbox.promote((yield* Database.Service).db, bus, childID, "input")
          // Twelve newer steps with nothing to show.
          for (let step = 0; step < 12; step++) {
            const assistantMessageID = SessionMessage.ID.create()
            yield* bus.publish(SessionEvent.Step.Started, {
              sessionID: childID,
              assistantMessageID,
              agent: Agent.ID.make("reviewer"),
              model: childModel,
            })
            yield* bus.publish(SessionEvent.Step.Ended, {
              sessionID: childID,
              assistantMessageID,
              finish: "stop",
              cost: Money.USD.zero,
              tokens,
            })
          }
          const transcript = (id: string, input: Record<string, unknown>) =>
            executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: { type: "tool-call" as const, id, name: "subagent_transcript", input },
            })
          const read = (id: string, input: Record<string, unknown>) =>
            transcript(id, input).pipe(
              Effect.map((result) => {
                if (result.status !== "completed") throw new Error(JSON.stringify(result))
                return Schema.decodeUnknownSync(SubagentTool.TranscriptOutput)(result.output)
              }),
            )
          const shown = (output: typeof SubagentTool.TranscriptOutput.Type) =>
            output.messages.map((message) => [message.role, message.text])

          // limit counts returned entries: the empty steps are read past to find two.
          const counted = yield* read("call-transcript-counted", { sessionID: childID, limit: 2 })
          expect(shown(counted)).toEqual([
            ["assistant", childText],
            ["user", "You are a subagent spawned by another session.\nreview this"],
          ])

          // At most ten records per entry asked for are scanned; the cursor resumes after the last one scanned.
          const bounded = yield* read("call-transcript-bounded", { sessionID: childID, limit: 1 })
          expect(bounded.messages).toEqual([])
          expect(bounded.cursor).toBeDefined()
          const resumed = yield* read("call-transcript-resumed", {
            sessionID: childID,
            limit: 1,
            cursor: bounded.cursor,
          })
          expect(shown(resumed)).toEqual([["user", "You are a subagent spawned by another session.\nreview this"]])
          expect(resumed.cursor).toBeDefined()

          // A grandchild's transcript is readable from here, but only a direct child can be continued.
          const grandchild = yield* sessions.create({
            parentID: childID,
            title: "deeper review",
            agent: Agent.ID.make("reviewer"),
          })
          expect(yield* read("call-transcript-grandchild", { sessionID: grandchild.id })).toMatchObject({
            sessionID: grandchild.id,
            title: "deeper review",
            messages: [],
          })
          expect(
            yield* executeTool(registry, {
              sessionID: parent.id,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-subagent-continue-grandchild",
                name: SubagentTool.name,
                input: { sessionID: grandchild.id, message: "continue" },
              },
            }),
          ).toMatchObject({
            status: "error",
            error: { message: `Session ${grandchild.id} is not a child of the current session` },
          })
        }),
      ),
    ),
  )
})

/**
 * A child's runs, stepped the way the runner drains them: each step takes the inbox and answers what it took. A test
 * can hold the next step, so a steer admitted meanwhile joins it, or the end of the next run: the gap between a drain's
 * last check and going idle, where a follow-up starts a run of its own.
 */
const stepping: {
  gate?: {
    readonly at: "step" | "settle"
    readonly entered: Deferred.Deferred<Session.ID>
    readonly release: Deferred.Deferred<void>
  }
} = {}
const answered = (texts: ReadonlyArray<string>) => `Answered: ${texts.join(" | ")}`

const steppedExecutionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const { db } = yield* Database.Service
      const runs = new Map<Session.ID, Deferred.Deferred<void>>()
      const pass = (sessionID: Session.ID, at: "step" | "settle") =>
        Effect.gen(function* () {
          const gate = stepping.gate
          if (gate === undefined || gate.at !== at) return
          stepping.gate = undefined
          yield* Deferred.succeed(gate.entered, sessionID)
          yield* Deferred.await(gate.release)
        })
      const texts = (items: ReadonlyArray<SessionInbox.Info>) =>
        items.flatMap((item) => (item.type === "user" ? [item.payload.text] : []))
      const drain = Effect.fn("SubagentTest.drain")(function* (sessionID: Session.ID) {
        while (true) {
          const taken = yield* SessionInbox.promoteItems(db, bus, sessionID, "input")
          if (taken.length === 0) return yield* pass(sessionID, "settle")
          yield* pass(sessionID, "step")
          const steered = yield* SessionInbox.promoteItems(db, bus, sessionID, "steer")
          const assistantMessageID = SessionMessage.ID.create()
          yield* bus.publish(SessionEvent.Step.Started, {
            sessionID,
            assistantMessageID,
            agent: Agent.ID.make("reviewer"),
            model: childModel,
          })
          yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
          yield* bus.publish(SessionEvent.Text.Ended, {
            sessionID,
            assistantMessageID,
            ordinal: 0,
            text: answered(texts([...taken, ...steered])),
          })
          yield* bus.publish(SessionEvent.Step.Ended, {
            sessionID,
            assistantMessageID,
            finish: "stop",
            cost: Money.USD.zero,
            tokens,
          })
        }
      })
      return SessionExecution.Service.of({
        active: Effect.sync(() => new Set(runs.keys())),
        isActive: (sessionID) => Effect.sync(() => runs.has(sessionID)),
        resume: (sessionID) =>
          Effect.gen(function* () {
            const current = runs.get(sessionID)
            if (current !== undefined) return yield* Deferred.await(current)
            const done = yield* Deferred.make<void>()
            runs.set(sessionID, done)
            yield* drain(sessionID).pipe(
              Effect.orDie,
              Effect.ensuring(
                Effect.sync(() => runs.delete(sessionID)).pipe(Effect.andThen(Deferred.succeed(done, undefined))),
              ),
            )
          }),
        wake: () => Effect.void,
        interrupt: () => Effect.succeed(false),
        awaitIdle: (sessionID) => Effect.suspend(() => runs.get(sessionID)?.pipe(Deferred.await) ?? Effect.void),
      })
    }),
  ),
  deps: [Bus.node, Database.node],
})
const followUpIt = testEffect(
  AppNodeBuilder.build(nodes, [
    [SessionExecution.node, steppedExecutionNode],
    [Global.node, tempGlobalLayer],
    [ExternalAgentDrivers.node, noVendorDrivers],
    [PluginSupervisor.node, subagentPluginSupervisor],
  ]),
)

describe("SubagentTool follow-ups", () => {
  const task = "You are a subagent spawned by another session.\nreview this"
  const delivered = "Delivered to the running subagent. Its result arrives with the call that is running it."
  const inDirectory = <A, E, R>(
    body: (call: (input: Record<string, unknown>) => ReturnType<typeof execute>) => Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((dir) =>
        Effect.gen(function* () {
          stepping.gate = undefined
          const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
          const sessions = yield* Session.Service
          const parent = yield* sessions.create({ location, model: parentModel })
          yield* withSubagent(parent.location)
          const locations = yield* LocationServiceMap.Service
          const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(parent.location)))
          const subagent = (yield* registeredTools(registry)).get(SubagentTool.name)
          if (!subagent) return yield* Effect.die("subagent is not registered")
          return yield* body((input) =>
            execute(subagent, input, {
              sessionID: parent.id,
              ...toolIdentity,
              id: Tool.CallID.make(crypto.randomUUID()),
              progress: () => Effect.void,
            }),
          )
        }),
      ),
    )
  const hold = (at: "step" | "settle") =>
    Effect.gen(function* () {
      const gate = { at, entered: yield* Deferred.make<Session.ID>(), release: yield* Deferred.make<void>() }
      stepping.gate = gate
      return gate
    })
  const start = { agent: "reviewer", description: "review", message: "review this" }

  followUpIt.live("steers a follow-up into a running child and returns at once; the running call answers it", () =>
    inDirectory((call) =>
      Effect.gen(function* () {
        const gate = yield* hold("step")
        const running = yield* call(start).pipe(Effect.forkChild)
        const childID = yield* Deferred.await(gate.entered)

        // The child is mid-step: the follow-up is delivered and returns without waiting for it.
        const followUp = yield* call({ sessionID: childID, message: "Also check the tests", description: "ignored" })
        expect(followUp.output).toEqual({ sessionID: childID, status: "delivered", message: delivered, output: null })
        expect(followUp.metadata).toEqual({ sessionID: childID, status: "delivered" })
        expect(followUp.content).toEqual([
          { type: "text", text: `<subagent sessionID="${childID}" state="delivered">\n${delivered}\n</subagent>` },
        ])

        yield* Deferred.succeed(gate.release, undefined)
        const result = yield* Fiber.join(running)
        // The step that was running took the follow-up as a steer, and the call returns its answer.
        expect(result.output).toMatchObject({
          sessionID: childID,
          status: "completed",
          message: answered([task, "Also check the tests"]),
        })
      }),
    ),
  )

  followUpIt.live("a follow-up delivered as the run ends is answered before the running call returns", () =>
    inDirectory((call) =>
      Effect.gen(function* () {
        const gate = yield* hold("settle")
        const running = yield* call(start).pipe(Effect.forkChild)
        // The run answered its task and is past its last check: the follow-up starts a run of its own.
        const childID = yield* Deferred.await(gate.entered)
        const followUp = yield* call({ sessionID: childID, message: "One more thing" })
        expect(followUp.output).toMatchObject({ status: "delivered" })
        yield* Deferred.succeed(gate.release, undefined)
        const result = yield* Fiber.join(running)
        expect(result.output).toMatchObject({ status: "completed", message: answered(["One more thing"]) })
      }),
    ),
  )

  followUpIt.live("delivers concurrent follow-ups, and the running call answers all of them", () =>
    inDirectory((call) =>
      Effect.gen(function* () {
        const gate = yield* hold("step")
        const running = yield* call(start).pipe(Effect.forkChild)
        const childID = yield* Deferred.await(gate.entered)
        const followUps = yield* Effect.all(
          [call({ sessionID: childID, message: "first" }), call({ sessionID: childID, message: "second" })],
          { concurrency: "unbounded" },
        )
        expect(followUps.map((item) => item.output)).toMatchObject([{ status: "delivered" }, { status: "delivered" }])
        yield* Deferred.succeed(gate.release, undefined)
        const result = yield* Fiber.join(running)
        const message = Schema.decodeUnknownSync(SubagentTool.Output)(result.output).message
        expect(message).toStartWith(answered([task]))
        expect(message).toContain("first")
        expect(message).toContain("second")
      }),
    ),
  )

  followUpIt.live("refuses a follow-up that passes what the running call owns, without marking the child failed", () =>
    inDirectory((call) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const gate = yield* hold("step")
        const running = yield* call(start).pipe(Effect.forkChild)
        const childID = yield* Deferred.await(gate.entered)
        const refused = yield* call({ sessionID: childID, message: "switch", agent: "reviewer", tools: [] }).pipe(
          Effect.flip,
        )
        expect(refused.message).toContain(`Subagent session ${childID} is still running an earlier call, which owns its agent, tools.`)
        expect(refused.metadata).toEqual({ status: "refused", reason: "running-call-owns-fields", target: childID })
        // Code Mode names a child failed by the sessionID in a failure's metadata; a refusal names none.
        expect(CodeModeChildren.sessionID(refused.metadata)).toBeUndefined()
        expect(
          (yield* sessions.inbox(childID)).flatMap((item) => (item.type === "user" ? [item.payload.text] : [])),
        ).toEqual([])

        yield* Deferred.succeed(gate.release, undefined)
        expect((yield* Fiber.join(running)).output).toMatchObject({ status: "completed", message: answered([task]) })
      }),
    ),
  )

  followUpIt.live("a call after the running call returned continues the child and returns its answer", () =>
    inDirectory((call) =>
      Effect.gen(function* () {
        const first = yield* call(start)
        const childID = outputSessionID(first.output)
        const continued = yield* call({ sessionID: childID, message: "continue" })
        expect(continued.output).toMatchObject({ sessionID: childID, status: "completed", message: answered(["continue"]) })

        // Two calls naming the idle child at once: one claims and runs it, the other is steered into that run.
        const gate = yield* hold("step")
        const left = yield* call({ sessionID: childID, message: "left" }).pipe(Effect.forkChild)
        const right = yield* call({ sessionID: childID, message: "right" }).pipe(Effect.forkChild)
        yield* Deferred.await(gate.entered)
        // The claimer is held mid-step, so the first call to return is the other one, steered into its run.
        const steered = yield* Effect.raceFirst(Fiber.join(left), Fiber.join(right))
        expect(steered.output).toMatchObject({ status: "delivered" })
        yield* Deferred.succeed(gate.release, undefined)
        const outputs = [yield* Fiber.join(left), yield* Fiber.join(right)].map((item) =>
          Schema.decodeUnknownSync(SubagentTool.Output)(item.output),
        )
        expect(outputs.map((output) => output.status).toSorted()).toEqual(["completed", "delivered"])
        const ran = outputs.find((output) => output.status === "completed")
        expect(ran?.message).toContain("left")
        expect(ran?.message).toContain("right")
      }),
    ),
  )
})
