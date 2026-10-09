import { describe, expect } from "bun:test"
import path from "path"
import { Context, Deferred, Effect, Layer, LayerMap, Schedule, Schema, type Scope, Stream } from "effect"
import { asc, eq } from "drizzle-orm"
import { AIError, LanguageModel, RateLimitError } from "@ocpp/ai"
import { OpenAIChat } from "@ocpp/ai/protocols/openai-chat"
import { TestLLM } from "@ocpp/ai/testing"
import { Agent } from "@ocpp/core/agent"
import { Bus } from "@ocpp/core/bus"
import { Catalog } from "@ocpp/core/catalog"
import { Config } from "@ocpp/core/config"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { LayerNodePlatform } from "@ocpp/core/effect/app-node-platform"
import { EventTable } from "@ocpp/core/event/sql"
import { InstructionDiscovery } from "@ocpp/core/instruction-discovery"
import { InstructionBuiltIns } from "@ocpp/core/instructions/builtins"
import { Instructions } from "@ocpp/core/instructions/index"
import { Location } from "@ocpp/core/location"
import { LocationServiceMap } from "@ocpp/core/location-service-map"
import type { LocationServices } from "@ocpp/core/location-services"
import { McpInstructions } from "@ocpp/core/mcp/instructions"
import { Image } from "@ocpp/core/image"
import { PluginHooks } from "@ocpp/core/plugin/hooks"
import { PluginRuntime } from "@ocpp/core/plugin/runtime"
import { SystemPromptPlugin } from "@ocpp/core/plugin/system-prompt"
import { Reference } from "@ocpp/core/reference"
import { Skill } from "@ocpp/core/skill"
import { PluginSupervisor } from "@ocpp/core/plugin/supervisor"
import { Project } from "@ocpp/core/project"
import { ProjectTable } from "@ocpp/core/project/sql"
import { ReferenceInstructions } from "@ocpp/core/reference/instructions"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { SessionModelTransport } from "@ocpp/core/session/model-transport"
import { SessionProjector } from "@ocpp/core/session/projector"
import { SessionPromptNode } from "@ocpp/core/session/prompt-node"
import { SessionRunnerModel } from "@ocpp/core/session/runner/model"
import { SessionInbox } from "@ocpp/core/session/inbox"
import { SessionMessage } from "@ocpp/core/session/message"
import { SessionTable } from "@ocpp/core/session/sql"
import { SessionStore } from "@ocpp/core/session/store"
import { SkillInstructions } from "@ocpp/core/skill/instructions"
import { Snapshot } from "@ocpp/core/snapshot"
import { Tool } from "@ocpp/core/tool"
import { SpecterSessions } from "@ocpp/core/specter/index"
import { SpecterStepHost } from "@ocpp/core/specter/step-host"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { agentHost, catalogHost, host } from "./plugin/host"

// OC++'s Session facade with the switch on: the embedded Specter runtime runs the Session, OC++ supplies
// each step's request, model stream and tools, and OC++ sees the runtime's facts on the Bus.
const languageModel = LanguageModel.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })

// The Location services are built once, bound to /project, like the runner's tests. The Session runtime
// reaches them through a LocationServiceMap that hands that context to every Location. Each app's Location services are its own context, handed over by setup; a step the runtime starts
// before then waits for it.
const locationContext = { current: Deferred.makeUnsafe<Context.Context<never>>() }
const sharedLocation = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: Layer.effect(
    LocationServiceMap.Service,
    Effect.suspend(() => {
      const context = Deferred.makeUnsafe<Context.Context<never>>()
      locationContext.current = context
      return LayerMap.make(
        (_ref: Location.Ref) => Layer.effectContext(Deferred.await(context)) as Layer.Layer<LocationServices>,
      )
    }),
  ),
  deps: [],
})

const pluginRuntime = PluginRuntime.makeCell()
const app = (database?: LayerNode.Node<Database.Service, never, any>) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionInbox.node,
      Session.node,
      SessionPromptNode.node,
      SpecterStepHost.stepIONode,
      PluginRuntime.node,
      PluginHooks.node,
      Agent.node,
      Catalog.node,
      Image.node,
      Skill.node,
      Reference.node,
      Tool.node,
      PluginRuntime.providerNodeWithCell(pluginRuntime),
    ]),
    [
      [Bus.node, Bus.configured({ persist: true })],
      [LocationServiceMap.node, sharedLocation],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [Snapshot.node, Snapshot.noopLayer],
      [LayerNodePlatform.llmClient, TestLLM.clientLayer],
      [
        SessionRunnerModel.node,
        Layer.mock(SessionRunnerModel.Service)({
          resolve: () =>
            Effect.succeed(
              SessionRunnerModel.resolved(languageModel, {
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                cost: [],
                limit: { context: 200_000, output: 32_000 },
              }),
            ),
        }),
      ],
      [
        InstructionBuiltIns.node,
        Layer.mock(InstructionBuiltIns.Service, { load: () => Effect.succeed(Instructions.empty) }),
      ],
      [
        InstructionDiscovery.node,
        Layer.mock(InstructionDiscovery.Service, {
          project: true,
          global: true,
          load: () => Effect.succeed(Instructions.empty),
        }),
      ],
      [
        SkillInstructions.node,
        Layer.mock(SkillInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
      ],
      [
        ReferenceInstructions.node,
        Layer.mock(ReferenceInstructions.Service, { load: () => Effect.succeed(Instructions.empty) }),
      ],
      [McpInstructions.node, Layer.mock(McpInstructions.Service, { load: () => Effect.succeed(Instructions.empty) })],
      [Config.node, Config.testLayer([])],
      [
        PluginSupervisor.node,
        Layer.succeed(PluginSupervisor.Service, PluginSupervisor.Service.of({ flush: Effect.void })),
      ],
      [
        SessionModelTransport.node,
        Layer.succeed(
          SessionModelTransport.Service,
          SessionModelTransport.Service.of({
            bind: () => ({ execute: () => Effect.die("Unexpected WebSocket execution") }),
            close: () => Effect.void,
            closeAll: Effect.void,
          }),
        ),
      ],
      [
        Catalog.node,
        Layer.mock(Catalog.Service, {
          provider: { get: () => Effect.undefined, all: () => Effect.succeed([]), available: () => Effect.succeed([]) },
          model: {
            get: () => Effect.undefined,
            all: () => Effect.succeed([]),
            available: () => Effect.succeed([]),
            default: () => Effect.undefined,
            small: () => Effect.undefined,
          },
        }),
      ],
      [PluginRuntime.node, PluginRuntime.layerWithCell(pluginRuntime)],
      [Reference.node, Layer.mock(Reference.Service, { refresh: () => Effect.void })],
      ...SpecterSessions.replacements,
      ...(database ? ([[Database.node, database]] as const) : []),
    ],
  ).pipe(Layer.provideMerge(TestLLM.layer({ fallback: [] })))
const it = testEffect(app())

// One boot of an app over a database file: its scope closing is the server shutting down. Each boot
// builds its own services, sharing none with another app (Layers memoize by identity).
const boot = <A, E>(file: string, effect: Effect.Effect<A, E, Layer.Success<ReturnType<typeof app>> | Scope.Scope>) =>
  Effect.gen(function* () {
    const services = yield* Layer.buildWithMemoMap(
      app(Database.configured({ path: file })),
      yield* Layer.makeMemoMap,
      yield* Effect.scope,
    )
    return yield* effect.pipe(Effect.provideContext(services))
  }).pipe(Effect.scoped)

const sessionID = Session.ID.make("ses_specter_test")

const setup = Effect.gen(function* () {
  yield* Deferred.succeed(locationContext.current, yield* Effect.context<never>())
  // OC++'s built-in agents come from its system prompt plugins, as in the runner's tests.
  const agents = yield* Agent.Service
  const hooks = yield* PluginHooks.Service
  const pluginHost = host({
    agent: agentHost(agents),
    catalog: catalogHost(yield* Catalog.Service),
    session: { hook: (name, callback) => hooks.register("session", name, callback) },
  })
  yield* Effect.forEach(SystemPromptPlugin.Plugins, (plugin) => plugin.effect(pluginHost), { discard: true })
  yield* agents.transform((draft) =>
    draft.update(Agent.ID.make("build"), (agent) => {
      agent.mode = "primary"
    }),
  )
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
})

const eventTypes = Database.Service.use(({ db }) =>
  db
    .select({ type: EventTable.type })
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => row.type.replace(/\.\d+$/, ""))),
    ),
)

describe("Sessions on the Specter runtime", () => {
  it.live("runs a prompt to a reply through OC++'s Session facade", () =>
    Effect.gen(function* () {
      yield* setup
      yield* TestLLM.push(TestLLM.text("Hello from Specter", "text_1"))
      const session = yield* Session.Service

      yield* session.prompt({ sessionID, text: "Hi" })
      yield* session.wait(sessionID)

      const messages = yield* session.messages({ sessionID, order: "asc" })
      expect(messages.map((message) => message.type)).toEqual(["user", "assistant"])
      const [user, assistant] = messages
      expect(user?.type === "user" ? user.text : undefined).toBe("Hi")
      expect(
        assistant?.type === "assistant"
          ? assistant.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          : [],
      ).toEqual(["Hello from Specter"])
      expect(yield* session.inbox(sessionID)).toEqual([])
      expect(yield* session.active).toEqual(new Set())
      expect(yield* eventTypes).toEqual([
        "session.inbox.enqueued",
        "session.execution.started",
        "session.instructions.updated",
        "session.inbox.delivered",
        "session.step.started",
        "session.text.started",
        "session.text.ended",
        "session.step.streamed",
        "session.step.ended",
        "session.execution.succeeded",
      ])
    }),
  )

  it.live("retries a rate-limited step as the same assistant message", () =>
    Effect.gen(function* () {
      yield* setup
      const llm = yield* TestLLM.Service
      yield* llm.push(
        Stream.fail(new AIError({ reason: new RateLimitError({ message: "Rate limited" }) })),
        TestLLM.text("Second try", "text_1"),
      )
      const session = yield* Session.Service

      yield* session.prompt({ sessionID, text: "Hi" })
      yield* session.wait(sessionID)

      const messages = yield* session.messages({ sessionID, order: "asc" })
      expect(messages.map((message) => message.type)).toEqual(["user", "assistant"])
      expect(
        messages[1]?.type === "assistant"
          ? messages[1].content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          : [],
      ).toEqual(["Second try"])
      expect(llm.requests).toHaveLength(2)
      expect(yield* eventTypes).toEqual([
        "session.inbox.enqueued",
        "session.execution.started",
        "session.instructions.updated",
        "session.inbox.delivered",
        "session.step.started",
        "session.retry.scheduled",
        "session.step.started",
        "session.text.started",
        "session.text.ended",
        "session.step.streamed",
        "session.step.ended",
        "session.execution.succeeded",
      ])
    }),
  )

  it.live("runs a Code Mode tool call and returns its result to the next step", () =>
    Effect.gen(function* () {
      yield* setup
      // OC++ offers Code Mode's execute once a tool is registered.
      yield* (yield* Tool.Service).transform((draft) =>
        draft.add({
          name: "echo",
          description: "Echo text",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          execute: ({ text }) => Effect.succeed({ output: { text }, content: text }),
        }),
      )
      const llm = yield* TestLLM.Service
      yield* llm.push(TestLLM.tool("call_1", "execute", { code: 'return "answer=" + 6 * 7' }))
      // OC++ runs the program as a job: the call settles at once, and the completion arrives as a
      // notification. Whether it lands before the next step or after it is timing, so the model
      // answers once it has seen the result.
      const seen = (request: { readonly messages: unknown }) => JSON.stringify(request.messages).includes("answer=42")
      yield* (llm.client as TestLLM.TestInterface).serve((request) =>
        seen(request) ? TestLLM.text("The answer is 42", "text_1") : TestLLM.text("Waiting for it", "text_1"),
      )
      const session = yield* Session.Service

      yield* session.prompt({ sessionID, text: "Compute it" })
      // A notification that lands after the execution settled wakes another one.
      const messages = yield* session.wait(sessionID).pipe(
        Effect.andThen(session.messages({ sessionID, order: "asc" })),
        Effect.repeat({
          until: (messages) => JSON.stringify(messages.at(-1)).includes("The answer is 42"),
          schedule: Schedule.spaced("20 millis"),
        }),
        Effect.timeout("5 seconds"),
      )
      yield* session.wait(sessionID)
      const tool =
        messages[1]?.type === "assistant" ? messages[1].content.find((part) => part.type === "tool") : undefined
      expect(tool?.type === "tool" ? tool.state.status : undefined).toBe("completed")
      const notice = messages.findIndex((message) => message.type === "synthetic")
      expect(messages[notice]?.type === "synthetic" ? messages[notice].text : "").toContain("answer=42")
      // The runtime delivered the notification before a step, and that step answered.
      expect(messages.at(-1)).toMatchObject({
        type: "assistant",
        content: [{ type: "text", text: "The answer is 42" }],
      })
      expect(messages.slice(notice + 1).map((message) => message.type)).toEqual(["assistant"])
      const types = yield* eventTypes
      expect(types.slice(0, 8)).toEqual([
        "session.inbox.enqueued",
        "session.execution.started",
        "session.instructions.updated",
        "session.inbox.delivered",
        "session.step.started",
        "session.tool.input.started",
        "session.tool.input.ended",
        "session.tool.called",
      ])
      // The end of the provider stream races the program, which starts and returns its result on the
      // tool call's own fiber.
      expect(types.slice(8, 11).toSorted()).toEqual([
        "session.codemode.started",
        "session.step.streamed",
        "session.tool.success",
      ])
      expect(types.indexOf("session.codemode.started")).toBeLessThan(types.indexOf("session.tool.success"))
      expect(types).toContain("session.codemode.completed")
      expect(types.slice(-2)).toEqual(["session.step.ended", "session.execution.succeeded"])
    }),
  )

  it.live("interrupts a running step and goes idle", () =>
    Effect.gen(function* () {
      yield* setup
      const llm = yield* TestLLM.Service
      const gate = yield* llm.gate
      yield* llm.push(TestLLM.text("Never seen", "text_1"))
      const session = yield* Session.Service

      yield* session.prompt({ sessionID, text: "Start" })
      yield* gate.started
      expect(yield* session.active).toEqual(new Set([sessionID]))
      expect(yield* session.interrupt(sessionID)).toBe(true)
      yield* session.wait(sessionID)
      yield* gate.release

      expect(yield* session.active).toEqual(new Set())
      expect(yield* session.interrupt(sessionID)).toBe(false)
      const types = yield* eventTypes
      expect(types.at(-1)).toBe("session.execution.interrupted")
      expect(types).not.toContain("session.text.started")
    }),
  )

  it.live("steers a queued input into the running execution", () =>
    Effect.gen(function* () {
      yield* setup
      const llm = yield* TestLLM.Service
      const gate = yield* llm.gate
      yield* llm.push(TestLLM.text("First answer", "text_1"), TestLLM.text("Second answer", "text_2"))
      const session = yield* Session.Service

      yield* session.prompt({ sessionID, text: "First" })
      yield* gate.started
      const queued = yield* session.prompt({ sessionID, text: "Later", delivery: "queue" })
      yield* session.steerInbox({ sessionID, inboxID: queued.id })
      yield* gate.release
      yield* session.wait(sessionID)

      const messages = yield* session.messages({ sessionID, order: "asc" })
      expect(messages.map((message) => (message.type === "user" ? message.text : message.type))).toEqual([
        "First",
        "assistant",
        "Later",
        "assistant",
      ])
      const types = yield* eventTypes
      expect(types).toContain("session.inbox.delivery.changed")
      // Steered input enters the same execution at the next step boundary.
      expect(types.filter((type) => type === "session.execution.started")).toHaveLength(1)
    }),
  )

  it.live("coalesces repeated notices into one input", () =>
    Effect.gen(function* () {
      yield* setup
      const llm = yield* TestLLM.Service
      const gate = yield* llm.gate
      yield* llm.push(TestLLM.text("Busy", "text_1"), TestLLM.text("Noted", "text_2"))
      const session = yield* Session.Service
      const notice = (text: string) =>
        session.synthetic({
          sessionID,
          text,
          delivery: "queue",
          coalesce: {
            key: "notices",
            merge: (replaced) => ({ text: [...replaced.map((payload) => payload.text), text].join(" + ") }),
          },
        })

      yield* session.prompt({ sessionID, text: "Start" })
      yield* gate.started
      yield* notice("one")
      yield* notice("two")
      expect(
        (yield* session.inbox(sessionID)).map((item) => (item.type === "synthetic" ? item.payload.text : item.type)),
      ).toEqual(["one + two"])
      yield* gate.release
      yield* session.wait(sessionID)

      const synthetic = (yield* session.messages({ sessionID, order: "asc" })).filter(
        (message) => message.type === "synthetic",
      )
      expect(synthetic.map((message) => (message.type === "synthetic" ? message.text : ""))).toEqual(["one + two"])
      expect(yield* eventTypes).toContain("session.inbox.cancelled")
    }),
  )

  it.live("holds a notice admitted without resume until the next prompt", () =>
    Effect.gen(function* () {
      yield* setup
      const llm = yield* TestLLM.Service
      yield* llm.push(TestLLM.text("Seen both", "text_1"))
      const session = yield* Session.Service

      yield* session.synthetic({ sessionID, text: "Shell finished", resume: false })
      yield* session.wait(sessionID)
      expect(yield* eventTypes).not.toContain("session.execution.started")
      expect((yield* session.inbox(sessionID)).map((item) => item.type)).toEqual(["synthetic"])

      // The next prompt wakes the Session, and its execution delivers the held notice with it.
      yield* session.prompt({ sessionID, text: "Continue" })
      yield* session.wait(sessionID)
      expect(yield* session.inbox(sessionID)).toEqual([])
      const messages = yield* session.messages({ sessionID, order: "asc" })
      expect(messages.map((message) => message.type)).toEqual(["synthetic", "user", "assistant"])
    }),
  )

  it.live("starts nothing at the next boot for a Session that settled", () =>
    Effect.gen(function* () {
      const file = path.join((yield* tmpdirScoped()).path, "ocpp.sqlite")
      yield* boot(
        file,
        Effect.gen(function* () {
          yield* setup
          yield* (yield* TestLLM.Service).push(TestLLM.text("First", "text_1"))
          const session = yield* Session.Service
          yield* session.prompt({ sessionID, text: "One" })
          yield* session.wait(sessionID)
        }),
      )
      yield* boot(
        file,
        Effect.gen(function* () {
          yield* setup
          const before = yield* eventTypes
          yield* (yield* TestLLM.Service).push(TestLLM.text("Second", "text_2"))
          const session = yield* Session.Service
          yield* session.prompt({ sessionID, text: "Two" })
          yield* session.wait(sessionID)
          // Replaying the log's Reactions at boot woke nothing: the prompt's execution is the only one.
          const after = (yield* eventTypes).slice(before.length)
          expect(after.filter((type) => type === "session.execution.started")).toHaveLength(1)
          const messages = yield* session.messages({ sessionID, order: "asc" })
          expect(messages.map((message) => message.type)).toEqual(["user", "assistant", "user", "assistant"])
        }),
      )
    }),
  )

  it.live("finishes a step the server stopped in at the next boot", () =>
    Effect.gen(function* () {
      const file = path.join((yield* tmpdirScoped()).path, "ocpp.sqlite")
      yield* boot(
        file,
        Effect.gen(function* () {
          yield* setup
          const llm = yield* TestLLM.Service
          const gate = yield* llm.gate
          yield* llm.push(TestLLM.text("Never seen", "text_1"))
          yield* (yield* Session.Service).prompt({ sessionID, text: "Start" })
          yield* gate.started
        }),
      )
      yield* boot(
        file,
        Effect.gen(function* () {
          yield* setup
          yield* (yield* TestLLM.Service).push(TestLLM.text("Answered after the restart", "text_1"))
          const session = yield* Session.Service
          yield* session.wait(sessionID)
          const assistant = (yield* session.messages({ sessionID, order: "asc" })).filter(
            (message) => message.type === "assistant",
          )
          expect(assistant.at(-1)).toMatchObject({
            content: [{ type: "text", text: "Answered after the restart" }],
          })
          expect((yield* eventTypes).at(-1)).toBe("session.execution.succeeded")
        }),
      )
    }),
  )

  it.live("compacts the history on request", () =>
    Effect.gen(function* () {
      yield* setup
      const llm = yield* TestLLM.Service
      yield* llm.push(TestLLM.text("Hello there", "text_1"), TestLLM.text("We said hello.", "text_2"))
      const session = yield* Session.Service

      yield* session.prompt({ sessionID, text: "Hi" })
      yield* session.wait(sessionID)
      yield* session.compact({ sessionID })
      yield* session.wait(sessionID)

      // The runtime delivers the compaction item; OC++ compacts and records its own facts.
      expect((yield* eventTypes).slice(10)).toEqual([
        "session.inbox.enqueued",
        "session.execution.started",
        "session.inbox.delivered",
        "session.compaction.started",
        "session.usage.recorded",
        "session.compaction.ended",
        "session.execution.succeeded",
      ])
      const last = (yield* session.messages({ sessionID, order: "asc" })).at(-1)
      expect(last?.type).toBe("compaction")
      expect(last?.type === "compaction" ? last.status : undefined).toBe("completed")
      expect(JSON.stringify(llm.requests[1]?.messages)).toContain("Hello there")
    }),
  )

  it.live("moves the Session when a move item is delivered", () =>
    Effect.gen(function* () {
      yield* setup
      const inbox = yield* SessionInbox.Service
      const session = yield* Session.Service

      yield* inbox.admit({
        id: SessionMessage.ID.create(),
        sessionID,
        item: SessionInbox.Item.make({
          type: "move",
          payload: {
            location: Location.Ref.make({ directory: AbsolutePath.make("/elsewhere") }),
            projectID: Project.ID.global,
          },
          delivery: "steer",
        }),
      })
      yield* session.wait(sessionID)

      expect((yield* eventTypes).slice(-4)).toEqual([
        "session.execution.started",
        "session.inbox.delivered",
        "session.moved",
        "session.execution.succeeded",
      ])
      const moved = yield* (yield* SessionStore.Service).get(sessionID)
      expect(String(moved?.location.directory)).toBe("/elsewhere")
    }),
  )

  it.live("answers without tools on the agent's last step", () =>
    Effect.gen(function* () {
      yield* setup
      yield* (yield* Agent.Service).transform((draft) =>
        draft.update(Agent.ID.make("build"), (agent) => {
          agent.steps = 1
        }),
      )
      const llm = yield* TestLLM.Service
      yield* llm.push(TestLLM.text("Wrapping up", "text_1"))
      const session = yield* Session.Service

      yield* session.prompt({ sessionID, text: "Hi" })
      yield* session.wait(sessionID)

      expect(llm.requests[0]?.toolChoice).toEqual({ type: "none" })
      expect(JSON.stringify(llm.requests[0]?.messages)).toContain("MAXIMUM STEPS REACHED")
    }),
  )

  it.live("cancels a queued input while a step runs", () =>
    Effect.gen(function* () {
      yield* setup
      const llm = yield* TestLLM.Service
      const gate = yield* llm.gate
      yield* llm.push(TestLLM.text("First answer", "text_1"))
      const session = yield* Session.Service

      yield* session.prompt({ sessionID, text: "First" })
      yield* gate.started
      const queued = yield* session.prompt({ sessionID, text: "Later", delivery: "queue" })
      expect((yield* session.inbox(sessionID)).map((item) => item.id)).toEqual([queued.id])
      yield* session.cancelInbox({ sessionID, inboxID: queued.id })
      expect(yield* session.inbox(sessionID)).toEqual([])
      yield* gate.release
      yield* session.wait(sessionID)

      const messages = yield* session.messages({ sessionID, order: "asc" })
      expect(messages.map((message) => (message.type === "user" ? message.text : message.type))).toEqual([
        "First",
        "assistant",
      ])
      expect(yield* eventTypes).toContain("session.inbox.cancelled")
      expect(llm.requests).toHaveLength(1)
    }),
  )
})
