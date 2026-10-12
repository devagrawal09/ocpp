import { describe, expect } from "bun:test"
import { SessionEvent } from "@ocpp/schema/session-event"
import path from "path"
import { Context, Deferred, Effect, Layer, LayerMap, Schedule, Schema, type Scope, Stream } from "effect"
import { asc, eq, sql } from "drizzle-orm"
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
import { Recorded } from "./lib/recorded"
import { InstructionDiscovery } from "@ocpp/core/instruction-discovery"
import { InstructionBuiltIns } from "@ocpp/core/instructions/builtins"
import { Instructions } from "@ocpp/core/instructions/index"
import { Location } from "@ocpp/core/location"
import { Credential } from "@ocpp/core/credential"
import { Integration } from "@ocpp/core/integration"
import { KV } from "@ocpp/core/kv"
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
import { InstructionStateTable, SessionTable } from "@ocpp/core/session/sql"
import { CodeModeCommandTable } from "@ocpp/core/codemode/command.sql"
import { CodeModeBindingTable } from "@ocpp/core/codemode/sql"
import { SessionStore } from "@ocpp/core/session/store"
import { SkillInstructions } from "@ocpp/core/skill/instructions"
import { Snapshot } from "@ocpp/core/snapshot"
import { Tool } from "@ocpp/core/tool"
import { SpecterRejection } from "@ocpp/core/specter/rejection"
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

// The built-in instructions a test's Sessions read: none, unless a test gives them a context, whose value each
// Session then stores by hash.
const builtins: { context?: string } = {}

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
      Credential.node,
      KV.node,
    ]),
    [
      [Bus.node, Bus.configured()],
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
        Layer.mock(InstructionBuiltIns.Service, {
          load: () =>
            Effect.sync(() =>
              builtins.context === undefined
                ? Instructions.empty
                : Instructions.make({
                    key: Instructions.Key.make("test/context"),
                    codec: Schema.toCodecJson(Schema.String),
                    read: Effect.succeed(builtins.context),
                    render: { initial: String, changed: (_previous, current) => current },
                  }),
            ),
        }),
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

const setupAgents = Effect.gen(function* () {
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
})

const setup = Effect.gen(function* () {
  yield* setupAgents
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  // The Session is created once; a later boot over the same database finds it.
  yield* (yield* Bus.Service)
    .command({
      type: "createSession",
      payload: {
        session: {
          sessionID,
          projectID: Project.ID.global,
          slug: "test",
          location: { directory: "/project" },
          title: "test",
          version: "test",
        },
      },
    })
    .pipe(
      Effect.catchIf(
        (error) => SpecterRejection.code(error) === "session-already-exists",
        () => Effect.void,
      ),
    )
})

// The Session's public events, as its log serves them: internal facts share its sequence.
const publicTypes = new Set<string>(SessionEvent.DurableDefinitions.map((definition) => definition.type))
const eventTypes = Recorded.types(sessionID).pipe(Effect.map((types) => types.filter((type) => publicTypes.has(type))))

// Every table OC++ projects from the log, with its rows. Specter's own tables, the index into the log,
// migrations, caches and credential keys are not projections.
const projections = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const tables = (yield* db
    .all<{ readonly name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'specter_%'
        AND name NOT IN ('migration', 'event', 'event_sequence', 'cache', 'credential_key') ORDER BY name`,
    )
    .pipe(Effect.orDie)).map((row) => row.name)
  return yield* Effect.forEach(tables, (table) =>
    db.all<Record<string, unknown>>(sql.raw(`SELECT * FROM "${table}"`)).pipe(
      Effect.orDie,
      Effect.map((rows) => [table, rows.map((row) => JSON.stringify(row)).toSorted()] as const),
    ),
  )
})

// Wipes every projection and rebuilds them from the log alone.
const rebuildProjections = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const tables = (yield* projections).map(([table]) => table)
  yield* db.run(sql`PRAGMA foreign_keys = OFF`).pipe(Effect.orDie)
  yield* Effect.forEach(tables, (table) => db.run(sql.raw(`DELETE FROM "${table}"`)).pipe(Effect.orDie), {
    discard: true,
  })
  yield* db.run(sql`PRAGMA foreign_keys = ON`).pipe(Effect.orDie)
  expect((yield* projections).every(([, rows]) => rows.length === 0)).toBeTrue()
  yield* (yield* Bus.Service).rebuild()
})

// The runtime's saved state: every Slice's snapshot, and how many facts the log holds.
const savedState = Database.Service.use(({ db }) =>
  Effect.all({
    slices: db.all<{ readonly slice: string; readonly cursor: number; readonly state: string }>(
      sql`SELECT slice_name AS slice, cursor, state_json AS state FROM specter_slice_snapshots ORDER BY slice_name`,
    ),
    facts: db.get<{ readonly count: number }>(sql`SELECT count(*) AS count FROM specter_events`),
  }).pipe(Effect.orDie),
)

// The facts the log keeps under a Session's key.
const keptOf = (sessionID: string) =>
  Database.Service.use(({ db }) =>
    db
      .all<{ readonly type: string }>(
        sql`SELECT e.type FROM specter_events e JOIN specter_event_keys k ON k.event_order = e.event_order
          WHERE k.name = 'session' AND k.value = ${sessionID} ORDER BY e.event_order`,
      )
      .pipe(Effect.orDie),
  )

/**
 * A Session saves a notebook function through a Code Mode program, with instructions and a command that calls it,
 * then is forked, and each fork forked again, `depth` forks in all. Every Session but the last fork is deleted, and
 * purged in full, though forks were made of it: the last fork recorded what it inherited, so it keeps its history,
 * notebook, command and instructions, its read models rebuild from the log alone, it runs a program that calls its
 * copied function, and a boot from the log alone saves the snapshots the boots that ran it saved.
 */
const forkOutlivesItsParents = (depth: number) =>
  Effect.gen(function* () {
    const file = path.join((yield* tmpdirScoped()).path, "ocpp.sqlite")
    builtins.context = "Forks keep this context"
    yield* Effect.addFinalizer(() => Effect.sync(() => delete builtins.context))
    yield* boot(
      file,
      Effect.gen(function* () {
        yield* setupAgents
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
        yield* llm.push(
          TestLLM.tool("call_1", "execute", {
            code: 'function report() { return "answer=" + 6 * 7 }\nreturn report()',
          }),
        )
        const said = (request: { readonly messages: unknown }, text: string) =>
          JSON.stringify(request.messages).includes(text)
        yield* (llm.client as TestLLM.TestInterface).serve((request) =>
          said(request, "again=answer=42")
            ? TestLLM.text("The fork says 42", "text_1")
            : said(request, "answer=42")
              ? TestLLM.text("The answer is 42", "text_1")
              : TestLLM.text("Waiting for it", "text_1"),
        )
        const session = yield* Session.Service
        const bus = yield* Bus.Service
        const { db } = yield* Database.Service
        const answered = (sessionID: Session.ID, text: string) =>
          session.wait(sessionID).pipe(
            Effect.andThen(session.messages({ sessionID, order: "asc" })),
            Effect.repeat({
              until: (messages) => JSON.stringify(messages.at(-1)).includes(text),
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("5 seconds"),
            Effect.andThen(session.wait(sessionID)),
          )

        const parent = yield* session.create({
          location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
        })
        yield* session.prompt({ sessionID: parent.id, text: "Compute it" })
        yield* answered(parent.id, "The answer is 42")
        // A command calling the saved function, as CodeModeCommand.define records it.
        yield* bus.command({
          type: "defineCodeModeCommand",
          payload: { sessionID: parent.id, name: "report", description: "Reports the answer", handler: "report" },
        })
        // The fork, and a fork of each fork.
        const chain = [parent]
        for (const _ of Array.from({ length: depth })) {
          const forked = yield* session.fork({ sessionID: chain.at(-1)!.id, boundary: { type: "through" } })
          chain.push(forked)
        }
        const last = chain.at(-1)!
        // What the last fork holds of its inheritance.
        const inherited = Effect.all({
          messages: session.messages({ sessionID: last.id, order: "asc" }),
          info: session.get(last.id),
          notebook: db
            .select({ name: CodeModeBindingTable.name, value: CodeModeBindingTable.value })
            .from(CodeModeBindingTable)
            .where(eq(CodeModeBindingTable.session_id, last.id))
            .all()
            .pipe(Effect.orDie),
          commands: db
            .select({ name: CodeModeCommandTable.name, handler: CodeModeCommandTable.handler })
            .from(CodeModeCommandTable)
            .where(eq(CodeModeCommandTable.session_id, last.id))
            .all()
            .pipe(Effect.orDie),
          instructions: db
            .select({ values: InstructionStateTable.current_values })
            .from(InstructionStateTable)
            .where(eq(InstructionStateTable.session_id, last.id))
            .get()
            .pipe(Effect.orDie),
        })
        const before = yield* inherited
        expect(before.messages.map((message) => message.type)).toEqual(
          (yield* session.messages({ sessionID: parent.id, order: "asc" })).map((message) => message.type),
        )
        expect(before.notebook.map((binding) => binding.name)).toEqual(["report"])
        expect(before.commands).toEqual([{ name: "report", handler: "report" }])
        expect(Object.keys(before.instructions?.values ?? {})).toContain("test/context")

        // Every Session before the last fork goes, oldest first, and purges in full: its forks read none of it.
        for (const removed of chain.slice(0, -1)) {
          yield* session.remove(removed.id)
          expect(
            yield* keptOf(removed.id).pipe(
              Effect.repeat({ until: (kept) => kept.length === 1, schedule: Schedule.spaced("20 millis") }),
              Effect.timeout("5 seconds"),
            ),
          ).toEqual([{ type: "session-deleted" }])
        }
        expect(yield* inherited).toEqual(before)
        expect(before.info.fork).toMatchObject({ sessionID: chain.at(-2)!.id })

        // The read models rebuild from the log alone as they are: the fork's history, notebook, command and
        // instruction values come from its own facts.
        const projected = yield* projections
        yield* rebuildProjections
        expect(yield* projections).toEqual(projected)
        expect(yield* inherited).toEqual(before)

        // The fork runs: its instruction values load, and a program calls the function its notebook copied.
        yield* llm.push(TestLLM.tool("call_2", "execute", { code: 'return "again=" + report()' }))
        yield* session.prompt({ sessionID: last.id, text: "Again" })
        yield* answered(last.id, "The fork says 42")
      }),
    )
    // A boot from the log alone saves the snapshots the boots that ran it saved.
    yield* boot(file, Effect.void)
    const resumed = yield* boot(file, savedState)
    yield* boot(
      file,
      Database.Service.use(({ db }) =>
        Effect.all([
          db.run(sql`DELETE FROM specter_slice_snapshots`),
          db.run(sql`DELETE FROM specter_reaction_outbox`),
        ]).pipe(Effect.orDie),
      ),
    )
    yield* boot(file, Effect.void)
    const rebuilt = yield* boot(file, savedState)
    expect(resumed.slices.length).toBeGreaterThan(20)
    // The same States: a fold of the purged log puts a tombstone where the whole log's fold first put the Session's
    // entry, so a record may list its keys in another order.
    const states = (slices: typeof resumed.slices) =>
      slices.map((slice) => ({ ...slice, state: JSON.parse(slice.state) as unknown }))
    expect(states(rebuilt.slices)).toEqual(states(resumed.slices))
    expect(rebuilt.facts).toEqual(resumed.facts)
  })

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
        "session-created",
        "session-inbox-enqueued",
        "session-execution-started",
        "session-instructions-updated",
        "session-inbox-delivered",
        "session-step-started",
        "session-block-recorded",
        "session-step-streamed",
        "session-step-settled",
        "session-execution-settled",
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
        "session-created",
        "session-inbox-enqueued",
        "session-execution-started",
        "session-instructions-updated",
        "session-inbox-delivered",
        "session-step-started",
        "session-step-settled",
        "session-step-started",
        "session-block-recorded",
        "session-step-streamed",
        "session-step-settled",
        "session-execution-settled",
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
      expect(types.slice(1, 7)).toEqual([
        "session-inbox-enqueued",
        "session-execution-started",
        "session-instructions-updated",
        "session-inbox-delivered",
        "session-step-started",
        "session-tool-requested",
      ])
      // The end of the provider stream races the program, which starts and returns its result on the
      // tool call's own fiber.
      expect(types.slice(7, 10).toSorted()).toEqual([
        "session-codemode-started",
        "session-step-streamed",
        "session-tool-settled",
      ])
      expect(types.indexOf("session-codemode-started")).toBeLessThan(types.indexOf("session-tool-settled"))
      expect(types).toContain("session-codemode-settled")
      expect(types.slice(-2)).toEqual(["session-step-settled", "session-execution-settled"])
    }),
  )

  it.live("rebuilds every read model from Specter's log alone", () =>
    Effect.gen(function* () {
      yield* setupAgents
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
      const seen = (request: { readonly messages: unknown }) => JSON.stringify(request.messages).includes("answer=42")
      yield* (llm.client as TestLLM.TestInterface).serve((request) =>
        seen(request) ? TestLLM.text("The answer is 42", "text_1") : TestLLM.text("Waiting for it", "text_1"),
      )
      // Everything below is recorded through OC++'s services: the project, the Session and its run, a
      // Code Mode program, a credential and plugin state.
      const session = yield* Session.Service
      const created = yield* session.create({
        location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
      })
      yield* session.prompt({ sessionID: created.id, text: "Compute it" })
      yield* session.wait(created.id).pipe(
        Effect.andThen(session.messages({ sessionID: created.id, order: "asc" })),
        Effect.repeat({
          until: (messages) => JSON.stringify(messages.at(-1)).includes("The answer is 42"),
          schedule: Schedule.spaced("20 millis"),
        }),
        Effect.timeout("5 seconds"),
      )
      yield* session.wait(created.id)
      const credentials = yield* Credential.Service
      const credential = yield* credentials.create({
        integrationID: Integration.ID.make("openai"),
        value: Credential.Key.make({ type: "key", key: "sk-rebuilt" }),
      })
      yield* credentials.update(credential.id, { label: "Work" })
      yield* (yield* KV.Service).set("plugin:rebuild", { count: 1 })

      const before = yield* projections
      const filled = new Set(before.flatMap(([table, rows]) => (rows.length > 0 ? [table] : [])))
      for (const table of [
        "project",
        "session_v2",
        "session_message",
        "codemode_execution",
        "credential",
        "credential_secret",
        "kv",
      ])
        expect(filled).toContain(table)

      yield* rebuildProjections

      expect(yield* projections).toEqual(before)
      expect((yield* credentials.get(credential.id))?.value).toEqual({ type: "key", key: "sk-rebuilt" })
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
      expect(types.at(-1)).toBe("session-execution-settled")
      expect(types).not.toContain("session-block-recorded")
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
      expect(types).toContain("session-inbox-delivery-changed")
      // Steered input enters the same execution at the next step boundary.
      expect(types.filter((type) => type === "session-execution-started")).toHaveLength(1)
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
      expect(yield* eventTypes).toContain("session-inbox-cancelled")
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
      expect(yield* eventTypes).not.toContain("session-execution-started")
      expect((yield* session.inbox(sessionID)).map((item) => item.type)).toEqual(["synthetic"])

      // The next prompt wakes the Session, and its execution delivers the held notice with it.
      yield* session.prompt({ sessionID, text: "Continue" })
      yield* session.wait(sessionID)
      expect(yield* session.inbox(sessionID)).toEqual([])
      const messages = yield* session.messages({ sessionID, order: "asc" })
      expect(messages.map((message) => message.type)).toEqual(["synthetic", "user", "assistant"])
    }),
  )

  it.live("saves only runtime state the log determines: a boot from the log alone holds the same", () =>
    Effect.gen(function* () {
      const file = path.join((yield* tmpdirScoped()).path, "ocpp.sqlite")
      const saved = Database.Service.use(({ db }) =>
        Effect.all({
          slices: db.all<{ readonly slice: string; readonly cursor: number; readonly state: string }>(
            sql`SELECT slice_name AS slice, cursor, state_json AS state FROM specter_slice_snapshots ORDER BY slice_name`,
          ),
          jobs: db.all<{ readonly status: string }>(sql`SELECT status FROM specter_reaction_outbox`),
          facts: db.get<{ readonly count: number }>(sql`SELECT count(*) AS count FROM specter_events`),
        }).pipe(Effect.orDie),
      )
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
      // A boot catches every Slice up from its snapshot and saves them when it stops: the log's state.
      // Snapshots are saved when a boot stops, so each is read at the next boot.
      yield* boot(file, Effect.void)
      const resumed = yield* boot(file, saved)
      // Without the runtime's saved state, a boot folds the log alone.
      yield* boot(
        file,
        Database.Service.use(({ db }) =>
          Effect.all([
            db.run(sql`DELETE FROM specter_slice_snapshots`),
            db.run(sql`DELETE FROM specter_reaction_outbox`),
          ]).pipe(Effect.orDie),
        ),
      )
      expect((yield* boot(file, saved)).slices).toEqual([])
      yield* boot(file, Effect.void)
      const rebuilt = yield* boot(file, saved)

      expect(resumed.slices.length).toBeGreaterThan(20)
      expect(rebuilt.slices).toEqual(resumed.slices)
      // Neither boot recorded a fact, and no work is left to do: the jobs ran or the log shows them done.
      expect(rebuilt.facts).toEqual(resumed.facts)
      expect(rebuilt.jobs.filter((job) => job.status !== "completed")).toEqual([])
    }),
  )

  it.live(
    "purges a deleted Session from the log, its index and every read model, and rebuilds the same",
    () =>
      Effect.gen(function* () {
        const file = path.join((yield* tmpdirScoped()).path, "ocpp.sqlite")
        const saved = Database.Service.use(({ db }) =>
          Effect.all({
            slices: db.all<{ readonly slice: string; readonly cursor: number; readonly state: string }>(
              sql`SELECT slice_name AS slice, cursor, state_json AS state FROM specter_slice_snapshots ORDER BY slice_name`,
            ),
            facts: db.get<{ readonly count: number }>(sql`SELECT count(*) AS count FROM specter_events`),
          }).pipe(Effect.orDie),
        )
        // What the log and its index hold that names a Session: its own facts and those of the aggregates it owns
        // (its Code Mode runs and their calls, its background job markers), which name it.
        const held = (id: string) =>
          Database.Service.use(({ db }) =>
            Effect.all({
              facts: db.all<{ readonly type: string }>(
                sql`SELECT type FROM specter_events WHERE payload LIKE ${`%${id}%`} ORDER BY event_order`,
              ),
              keys: db.all<{ readonly name: string; readonly value: string }>(
                sql`SELECT k.name, k.value FROM specter_event_keys k JOIN specter_events e ON e.event_order = k.event_order
                WHERE e.payload LIKE ${`%${id}%`} ORDER BY k.event_order, k.name`,
              ),
              indexed: db.all<{ readonly aggregate: string }>(
                sql`SELECT x.aggregate_id AS aggregate FROM event x JOIN specter_events e ON e.event_order = x.log_order
                WHERE e.payload LIKE ${`%${id}%`}`,
              ),
              sequences: db.all<{ readonly aggregate: string }>(
                sql`SELECT aggregate_id AS aggregate FROM event_sequence
                WHERE aggregate_id NOT IN (SELECT aggregate_id FROM event)`,
              ),
            }).pipe(Effect.orDie),
          )
        const removed = yield* boot(
          file,
          Effect.gen(function* () {
            yield* setupAgents
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
            yield* llm.push(
              TestLLM.text("Staying", "text_1"),
              TestLLM.tool("call_1", "execute", { code: 'tools.echo({ text: "hi" })\nreturn "answer=" + 6 * 7' }),
            )
            const seen = (request: { readonly messages: unknown }) =>
              JSON.stringify(request.messages).includes("answer=42")
            yield* (llm.client as TestLLM.TestInterface).serve((request) =>
              seen(request) ? TestLLM.text("The answer is 42", "text_1") : TestLLM.text("Waiting for it", "text_1"),
            )
            const session = yield* Session.Service
            const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
            // A Session that stays, and one with a run, a Code Mode program and its tool call, and a user shell.
            const stays = yield* session.create({ location })
            yield* session.prompt({ sessionID: stays.id, text: "Stay" })
            yield* session.wait(stays.id)
            const goes = yield* session.create({ location })
            yield* session.prompt({ sessionID: goes.id, text: "Compute it" })
            yield* session.wait(goes.id).pipe(
              Effect.andThen(session.messages({ sessionID: goes.id, order: "asc" })),
              Effect.repeat({
                until: (messages) => JSON.stringify(messages.at(-1)).includes("The answer is 42"),
                schedule: Schedule.spaced("20 millis"),
              }),
              Effect.timeout("5 seconds"),
            )
            yield* session.wait(goes.id)
            // A user shell, recorded through its Commands as Session.shell records it.
            const bus = yield* Bus.Service
            yield* bus.command({
              type: "runShell",
              payload: {
                sessionID: goes.id,
                shell: {
                  id: "sh_purged",
                  status: "running",
                  command: "pwd",
                  cwd: "/project",
                  shell: "/bin/sh",
                  file: "/tmp/sh_purged.out",
                  metadata: { background: true },
                  time: { started: 0 },
                },
              },
            })
            yield* bus.command({
              type: "settleShell",
              payload: {
                sessionID: goes.id,
                shellID: "sh_purged",
                outcome: "exited",
                exit: 0,
                output: { output: "/project", cursor: 8, size: 8, truncated: false },
              },
            })
            const before = yield* held(goes.id)
            for (const type of [
              "session-codemode-execution-settled",
              "session-codemode-call-scheduled",
              "session-background-started",
              "session-shell-settled",
              "session-tool-settled",
            ])
              expect(before.facts.map((fact) => fact.type)).toContain(type)
            const staying = yield* held(stays.id)

            yield* session.remove(goes.id)
            // Its purge runs once its deletion commits: its tombstone is all that is left.
            const after = yield* held(goes.id).pipe(
              Effect.repeat({
                until: (held) => held.facts.length === 1,
                schedule: Schedule.spaced("20 millis"),
              }),
              Effect.timeout("5 seconds"),
            )
            expect(after.facts).toEqual([{ type: "session-deleted" }])
            expect(after.keys).toEqual([{ name: "session", value: goes.id }])
            expect(after.indexed).toEqual([])
            expect(after.sequences).toEqual([])
            expect(yield* held(stays.id)).toEqual(staying)
            // No read model holds anything of it.
            const projected = yield* projections
            expect(
              projected.flatMap(([table, rows]) => rows.filter((row) => row.includes(goes.id)).map(() => table)),
            ).toEqual([])
            expect(projected.find(([table]) => table === "session_message")?.[1].length).toBeGreaterThan(0)

            // The read models rebuild from the log alone as they are.
            yield* rebuildProjections
            expect(yield* projections).toEqual(projected)

            // Its ID is still refused.
            const refused = yield* (yield* Bus.Service)
              .command({
                type: "createSession",
                payload: {
                  session: {
                    sessionID: goes.id,
                    projectID: goes.projectID,
                    slug: "again",
                    location: { directory: "/project" },
                    title: "again",
                    version: "test",
                  },
                },
              })
              .pipe(Effect.flip)
            expect(SpecterRejection.code(refused)).toBe("session-deleted")
            return goes.id
          }),
        )
        // A boot from the log alone saves the snapshots the boots that ran it saved.
        yield* boot(file, Effect.void)
        const resumed = yield* boot(file, saved)
        yield* boot(
          file,
          Database.Service.use(({ db }) =>
            Effect.all([
              db.run(sql`DELETE FROM specter_slice_snapshots`),
              db.run(sql`DELETE FROM specter_reaction_outbox`),
            ]).pipe(Effect.orDie),
          ),
        )
        yield* boot(file, Effect.void)
        const rebuilt = yield* boot(file, saved)
        expect(resumed.slices.length).toBeGreaterThan(20)
        expect(rebuilt.slices).toEqual(resumed.slices)
        expect(rebuilt.facts).toEqual(resumed.facts)
        expect(resumed.slices.filter((slice) => slice.state.includes(removed)).map((slice) => slice.slice)).toEqual(
          expect.arrayContaining(["createSession"]),
        )
        // Each Slice holds its tombstone, if any, and nothing else of it.
        for (const slice of resumed.slices)
          if (slice.state.includes(removed)) expect(slice.state.split(removed).length - 1).toBe(1)
      }),
    30_000,
  )

  it.live(
    "purges a forked parent in full, and its fork runs, rebuilds and boots from what it recorded",
    () => forkOutlivesItsParents(1),
    30_000,
  )

  it.live(
    "purges every Session of a chain of forks but the last, which runs, rebuilds and boots from what it recorded",
    () => forkOutlivesItsParents(2),
    30_000,
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
          expect(after.filter((type) => type === "session-execution-started")).toHaveLength(1)
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
          expect((yield* eventTypes).at(-1)).toBe("session-execution-settled")
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
        "session-inbox-enqueued",
        "session-execution-started",
        "session-inbox-delivered",
        "session-compaction-started",
        "session-usage-recorded",
        "session-compaction-settled",
        "session-execution-settled",
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
        "session-execution-started",
        "session-inbox-delivered",
        "session-moved",
        "session-execution-settled",
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
      expect(yield* eventTypes).toContain("session-inbox-cancelled")
      expect(llm.requests).toHaveLength(1)
    }),
  )
})
