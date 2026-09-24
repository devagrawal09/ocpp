import { HttpRecorder } from "@ocpp/http-recorder"
import { OpenAIChat } from "@ocpp/ai/protocols/openai-chat"
import { Auth, LLMClient, RequestExecutor } from "@ocpp/ai/route"
import { Catalog } from "@ocpp/core/catalog"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { LayerNodePlatform } from "@ocpp/core/effect/app-node-platform"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Bus } from "@ocpp/core/bus"
import { EventTable } from "@ocpp/core/event/sql"
import { Permission } from "@ocpp/core/permission"
import { Agent } from "@ocpp/core/agent"
import { Config } from "@ocpp/core/config"
import { Project } from "@ocpp/core/project"
import { ProjectTable } from "@ocpp/core/project/sql"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { Snapshot } from "@ocpp/core/snapshot"
import { SessionProjector } from "@ocpp/core/session/projector"
import { SessionExecution } from "@ocpp/core/session/execution"
import { SessionRunCoordinator } from "@ocpp/core/session/run-coordinator"
import { SessionRunner } from "@ocpp/core/session/runner/index"
import { SessionRunnerLLM } from "@ocpp/core/session/runner/llm"
import { SessionRunnerModel } from "@ocpp/core/session/runner/model"
import { Tool } from "@ocpp/core/tool"
import { SessionTable } from "@ocpp/core/session/sql"
import { SessionStore } from "@ocpp/core/session/store"
import { Location } from "@ocpp/core/location"
import { InstructionBuiltIns } from "@ocpp/core/instructions/builtins"
import { InstructionDiscovery } from "@ocpp/core/instruction-discovery"
import { Instructions } from "@ocpp/core/instructions/index"
import { SkillInstructions } from "@ocpp/core/skill/instructions"
import { ReferenceInstructions } from "@ocpp/core/reference/instructions"
import { McpInstructions } from "@ocpp/core/mcp/instructions"
import { PluginSupervisor } from "@ocpp/core/plugin/supervisor"
import { PluginHooks } from "@ocpp/core/plugin/hooks"
import { SystemPromptPlugin } from "@ocpp/core/plugin/system-prompt"
import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import path from "node:path"
import { testEffect } from "./lib/effect"
import { LocationServiceMap } from "@ocpp/core/location-service-map"
import { promptLocationNode } from "./fixture/prompt-location"
import { permissionLayer } from "./lib/permission"
import { agentHost, catalogHost, host } from "./plugin/host"

const cassetteName = "session-runner/openai-chat-streams-text"
const cassetteDirectory = path.resolve(import.meta.dir, "fixtures/recordings")
if (process.env.RECORD === "true") {
  if (process.env.CI !== undefined) throw new Error("Unset CI before recording HTTP cassettes")
  HttpRecorder.removeCassetteSync(cassetteName, { directory: cassetteDirectory })
}
const cassette = HttpRecorder.layerFetch(cassetteName, { directory: cassetteDirectory })
const executor = RequestExecutor.layer.pipe(Layer.provide(cassette))
const client = LLMClient.layer.pipe(Layer.provide(executor))
const permission = permissionLayer()
const model = OpenAIChat.route
  .with({
    endpoint: { baseURL: "https://api.openai.com/v1" },
    auth: Auth.bearer(process.env.OPENAI_API_KEY ?? "fixture"),
    generation: { maxTokens: 20, temperature: 0 },
  })
  .model({ id: "gpt-4o-mini" })
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: () =>
    Effect.succeed(
      SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        cost: [],
        limit: { context: 200_000, output: 20 },
      }),
    ),
})
const systemContext = Layer.mock(InstructionBuiltIns.Service, { load: () => Effect.succeed(Instructions.empty) })
const instructionContext = Layer.mock(InstructionDiscovery.Service, {
  project: true,
  global: true,
  load: () => Effect.succeed(Instructions.empty),
})
const skillInstructions = Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const referenceInstructions = Layer.mock(ReferenceInstructions.Service, {
  load: () => Effect.succeed(Instructions.empty),
})
const mcpInstructions = Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })
const config = Config.testLayer()
const pluginSupervisor = Layer.succeed(PluginSupervisor.Service, PluginSupervisor.Service.of({ flush: Effect.void }))
const promptCatalog = Layer.mock(Catalog.Service, {
  provider: {
    get: () => Effect.undefined,
    all: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
  },
  model: {
    get: () => Effect.undefined,
    all: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
    default: () => Effect.undefined,
    small: () => Effect.undefined,
  },
})
const runnerLayer = (llmClient: Layer.Layer<typeof LLMClient.Service>) =>
  AppNodeBuilder.build(SessionRunnerLLM.node, [
    [Snapshot.node, Snapshot.noopLayer],
    [LayerNodePlatform.llmClient, llmClient],
    [SessionRunnerModel.node, models],
    [InstructionBuiltIns.node, systemContext],
    [InstructionDiscovery.node, instructionContext],
    [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
    [SkillInstructions.node, skillInstructions],
    [ReferenceInstructions.node, referenceInstructions],
    [McpInstructions.node, mcpInstructions],
    [Config.node, config],
    [Permission.node, permission],
    [PluginSupervisor.node, pluginSupervisor],
  ])
const execution = (llmClient: Layer.Layer<typeof LLMClient.Service>) =>
  Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const sessionRunner = yield* SessionRunner.Service
      const coordinator = yield* SessionRunCoordinator.make<Session.ID, SessionRunner.RunError>({
        drain: (sessionID, force) => sessionRunner.drain({ sessionID, force }).pipe(Effect.asVoid),
      })
      return SessionExecution.Service.of({
        active: coordinator.active,
        isActive: coordinator.isActive,
        resume: coordinator.run,
        wake: coordinator.wake,
        interrupt: (sessionID) => coordinator.interrupt(sessionID),
        awaitIdle: coordinator.awaitIdle,
      })
    }),
  ).pipe(Layer.provide(runnerLayer(llmClient)))
const testLayer = (llmClient: Layer.Layer<typeof LLMClient.Service>) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Agent.node,
      Catalog.node,
      PluginHooks.node,
      Tool.node,
      SessionRunnerModel.node,
      InstructionBuiltIns.node,
      InstructionDiscovery.node,
      SkillInstructions.node,
      ReferenceInstructions.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      Session.node,
    ]),
    [
      [Bus.node, Bus.configured({ persist: true })],
      [LocationServiceMap.node, promptLocationNode],
      [LayerNodePlatform.llmClient, llmClient],
      [Permission.node, permission],
      [Catalog.node, promptCatalog],
      [SessionRunnerModel.node, models],
      [InstructionBuiltIns.node, systemContext],
      [InstructionDiscovery.node, instructionContext],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [SkillInstructions.node, skillInstructions],
      [ReferenceInstructions.node, referenceInstructions],
      [Config.node, config],
      [Snapshot.node, Snapshot.noopLayer],
      [PluginSupervisor.node, pluginSupervisor],
      [SessionExecution.node, execution(llmClient)],
    ],
  )
const it = testEffect(testLayer(client))
const sessionID = Session.ID.make("ses_runner_recorded")

describe("SessionRunnerLLM recorded", () => {
  it.effect("executes one recorded prompt through the recorded HTTP transport", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const catalog = yield* Catalog.Service
      const hooks = yield* PluginHooks.Service
      yield* agents.transform((draft) =>
        draft.update(Agent.ID.make("build"), (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "execute", resource: "*", effect: "deny" })
        }),
      )
      const pluginHost = host({
        agent: agentHost(agents),
        catalog: catalogHost(catalog),
        session: { hook: (name, callback) => hooks.register("session", name, callback) },
      })
      yield* Effect.forEach(SystemPromptPlugin.Plugins, (plugin) => plugin.effect(pluginHost), { discard: true })
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const session = yield* Session.Service
      const prompt = yield* session.prompt({
        sessionID,
        text: "Say hello in one short sentence.",
        resume: false,
      })

      yield* session.resume(sessionID)

      const messages = yield* session.context(sessionID)
      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({ id: prompt.id, type: "user", text: "Say hello in one short sentence." })
      expect(messages[1]).toMatchObject({ type: "assistant", agent: "build", finish: "stop" })
      expect(messages[1]?.type === "assistant" ? messages[1].content : []).toMatchObject([
        { type: "text", text: "Hello!" },
      ])
      expect(
        (yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, sessionID))
          .orderBy(EventTable.seq)
          .all()).map((event) => event.type),
      ).toEqual([
        "session.inbox.enqueued.1",
        "session.instructions.updated.2",
        "session.inbox.delivered.1",
        "session.step.started.1",
        "session.text.started.1",
        "session.text.ended.1",
        "session.step.streamed.1",
        "session.step.ended.1",
      ])
    }),
  )
})

describe("SessionModelRequest HTTP bridge", () => {
  const bodies: Uint8Array[] = []
  const methods: string[] = []
  const headers: Array<string | undefined> = []
  const response = [
    'data: {"id":"chatcmpl_test","object":"chat.completion.chunk","created":0,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello!"},"finish_reason":null}]}',
    'data: {"id":"chatcmpl_test","object":"chat.completion.chunk","created":0,"model":"gpt-4o-mini","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    "data: [DONE]",
    "",
  ].join("\n\n")
  const transport = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.body._tag !== "Uint8Array") throw new Error(`Unexpected request body: ${request.body._tag}`)
        methods.push(request.method)
        bodies.push(request.body.body.slice())
        headers.push(request.headers["x-hook"])
        return HttpClientResponse.fromWeb(
          request,
          new Response(response, { headers: { "content-type": "text/event-stream" } }),
        )
      }),
    ),
  )
  const httpIt = testEffect(
    testLayer(LLMClient.layer.pipe(Layer.provide(RequestExecutor.layer.pipe(Layer.provide(transport))))),
  )

  httpIt.effect("runs Effect HTTP request and response hooks around one provider request", () =>
    Effect.gen(function* () {
      bodies.length = 0
      methods.length = 0
      headers.length = 0
      const seen: string[] = []
      const agents = yield* Agent.Service
      const catalog = yield* Catalog.Service
      const hooks = yield* PluginHooks.Service
      yield* agents.transform((draft) =>
        draft.update(Agent.ID.make("build"), (agent) => {
          agent.mode = "primary"
          agent.permissions.push({ action: "execute", resource: "*", effect: "deny" })
        }),
      )
      const pluginHost = host({
        agent: agentHost(agents),
        catalog: catalogHost(catalog),
        session: { hook: (name, callback) => hooks.register("session", name, callback) },
      })
      yield* pluginHost.session.hook("http.request", (event) =>
        Effect.sync(() => {
          seen.push("request")
          event.request.headers.set("x-hook", "effect")
        }),
      )
      yield* pluginHost.session.hook("http.response", (event) =>
        Effect.gen(function* () {
          seen.push(`response:${event.response.status}:${event.request.headers.get("x-hook")}`)
          event.response = new Response(
            (yield* Effect.promise(() => event.response.text())).replace("Hello!", "Hooked!"),
            event.response,
          )
        }),
      )
      yield* Effect.forEach(SystemPromptPlugin.Plugins, (plugin) => plugin.effect(pluginHost), { discard: true })
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
      const sessionID = Session.ID.make("ses_model_request_http")
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const session = yield* Session.Service
      yield* session.prompt({ sessionID, text: "Say hello.", resume: false })

      yield* session.resume(sessionID)

      expect(methods).toEqual(["POST"])
      expect(headers).toEqual(["effect"])
      expect(seen).toEqual(["request", "response:200:effect"])
      expect(bodies).toHaveLength(1)
      expect(bodies[0]?.byteLength).toBeGreaterThan(0)
      expect((yield* session.context(sessionID))[1]).toMatchObject({
        type: "assistant",
        content: [{ type: "text", text: "Hooked!" }],
      })
    }),
  )
})
