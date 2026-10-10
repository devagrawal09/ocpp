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
import { makeLocationNode } from "@ocpp/util/effect/app-node"
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
import { TestStepHost } from "./fixture/step-host"

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

/** The prompts a Session's history holds, oldest first: the runtime delivers each before the step answering it. */
const userTexts = (sessionID: Session.ID) =>
  Session.Service.use((sessions) => sessions.messages({ sessionID, order: "asc" })).pipe(
    Effect.map((messages) => messages.flatMap((message) => (message.type === "user" ? [message.text] : []))),
  )

const outputSessionID = (value: unknown) =>
  Schema.decodeUnknownSync(Schema.Struct({ sessionID: Session.ID }))(value).sessionID

// A child answers in one step with its final text, or fails to resolve a model when its title asks it to.
const steps = TestStepHost.make({
  step: (sessionID) =>
    SessionStore.Service.use((store) => store.get(sessionID)).pipe(
      Effect.map((session): TestStepHost.Step | undefined => {
        if (!session?.parentID) return undefined
        if (session.title?.includes("fail"))
          return {
            finish: "error",
            retryable: false,
            error: { type: "provider.no-route", message: `No model is available for session ${sessionID}` },
          }
        return { finish: "stop", text: childText, agent: "reviewer", model: childModel }
      }),
    ),
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
  steps.replacement,
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
          expect((yield* userTexts(child.id))[0]).toBe("You are a subagent spawned by another session.\nreview this")

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
          expect(yield* userTexts(childID)).toEqual([
            "You are a subagent spawned by another session.\nreview this",
            "continue this",
          ])
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
          expect(yield* userTexts(childID)).toEqual([
            "You are a subagent spawned by another session.\nreview this",
            "continue this",
          ])
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
          // A later step that ran a Code Mode execution whose metadata carries private data.
          const assistantMessageID = SessionMessage.ID.create()
          const base = { sessionID: childID, assistantMessageID, id: "call-child-execute" }
          yield* bus.publish(SessionEvent.Step.Started, {
            sessionID: childID,
            assistantMessageID,
            agent: Agent.ID.make("reviewer"),
            model: childModel,
          })
          yield* bus.publish(SessionEvent.Tool.Requested, {
            ...base,
            name: "execute",
            input: { code: "return 1" },
            executed: true,
          })
          yield* bus.publish(SessionEvent.Tool.Settled, {
            ...base,
            content: [{ type: "text", text: "Preview: 1" }],
            metadata: { executionID: "exe_secret", events: [{ input: secret }] },
            executed: true,
            outcome: "succeeded",
          })
          yield* bus.publish(SessionEvent.Step.Settled, {
            sessionID: childID,
            assistantMessageID,
            finish: "stop",
            cost: Money.USD.zero,
            tokens,
            outcome: "succeeded",
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
          // Without include, the tool-only step has nothing to show. The runtime delivered the prompt before the
          // step that answered it.
          expect(plain.output.messages.map((message) => [message.role, message.text])).toEqual([
            ["user", "You are a subagent spawned by another session.\nreview this"],
            ["assistant", childText],
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
          const prompts = () => userTexts(childID)
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
          expect(yield* userTexts(childID)).toEqual([
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
          // The runtime delivered both prompts, each before the step that answered it in text.
          const prompts = (yield* sessions.messages({ sessionID: childID, order: "asc" })).flatMap((message) =>
            message.type === "user" ? [message.text] : [],
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
          const prompts = userTexts

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
          expect(JSON.stringify(yield* sessions.messages({ sessionID: held.id }))).toContain(
            "The server restarted while you were working",
          )

          // Neither recovery created another child.
          expect((yield* sessions.list({ parentID: parent.id })).data).toHaveLength(2)

          // A continued child's history cannot show whether the message arrived, so the call fails and names it.
          const refused = yield* recover("call-subagent-refuse", held.id, { sessionID: held.id }).pipe(Effect.flip)
          expect(refused.message).toContain(
            `continuing subagent session ${held.id}, which may or may not have received`,
          )
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
          // Twelve newer steps with nothing to show.
          for (let step = 0; step < 12; step++) {
            const assistantMessageID = SessionMessage.ID.create()
            yield* bus.publish(SessionEvent.Step.Started, {
              sessionID: childID,
              assistantMessageID,
              agent: Agent.ID.make("reviewer"),
              model: childModel,
            })
            yield* bus.publish(SessionEvent.Step.Settled, {
              sessionID: childID,
              assistantMessageID,
              finish: "stop",
              cost: Money.USD.zero,
              tokens,
              outcome: "succeeded",
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
            ["user", "You are a subagent spawned by another session.\nreview this"],
            ["assistant", childText],
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
          expect(shown(resumed)).toEqual([["assistant", childText]])
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
