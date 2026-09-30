import { afterAll, describe, expect, test } from "bun:test"
import path from "path"
import { CodeMode } from "@ocpp/codemode"
import { CodeModeExecution } from "@ocpp/schema/codemode-execution"
import { Money } from "@ocpp/schema/money"
import { Deferred, Effect, Layer, Schema, type Scope } from "effect"
import { Agent } from "@ocpp/core/agent"
import { Bus } from "@ocpp/core/bus"
import { Catalog } from "@ocpp/core/catalog"
import { CodeModeCommand } from "@ocpp/core/codemode/command"
import { CodeModeResume } from "@ocpp/core/codemode/resume"
import { CodeModeStore } from "@ocpp/core/codemode/store"
import { CodeModeInstructions } from "@ocpp/core/codemode/instructions"
import { Config } from "@ocpp/core/config"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { Job } from "@ocpp/core/job"
import { KV } from "@ocpp/core/kv"
import { Location } from "@ocpp/core/location"
import { LocationServiceMap } from "@ocpp/core/location-service-map"
import { Model } from "@ocpp/core/model"
import { OpenApi } from "@ocpp/core/openapi/index"
import { PluginRuntime } from "@ocpp/core/plugin/runtime"
import { PluginSupervisor } from "@ocpp/core/plugin/supervisor"
import { Provider } from "@ocpp/core/provider"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { SessionEvent } from "@ocpp/core/session/event"
import { SessionExecution } from "@ocpp/core/session/execution"
import { SessionRestart } from "@ocpp/core/session/execution/restart"
import { SessionInbox } from "@ocpp/core/session/inbox"
import { SessionMessage } from "@ocpp/core/session/message"
import { SessionStore } from "@ocpp/core/session/store"
import { Tool } from "@ocpp/core/tool"
import { SubagentTool } from "@ocpp/core/tool/plugin/subagent"
import { ExternalAgentDrivers } from "@ocpp/core/external-agent/drivers"
import { ExternalAgentSession } from "@ocpp/core/external-agent/session"
import { noVendorDrivers } from "./lib/drivers"
import { makeGlobalNode, makeLocationNode } from "@ocpp/util/effect/app-node"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { FSUtil } from "@ocpp/util/fs-util"
import { Global } from "@ocpp/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import {
  activateCodeMode,
  readCodeModeNotebook,
  registerToolPlugin,
  seedToolSession,
  toolIdentity,
  waitForCodeModeExecution,
} from "./lib/tool"

const childText = "child review done"
const tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
/** Sessions whose model a notification woke. */
const wakes: Array<Session.ID> = []

// Drains complete in one scripted step, so a rejoined child answers without a model.
const executionNode = makeGlobalNode({
  service: SessionExecution.Service,
  layer: Layer.effect(
    SessionExecution.Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const answer = Effect.fn("CodeModeResumeTest.answer")(function* (sessionID: Session.ID) {
        const assistantMessageID = SessionMessage.ID.create()
        yield* bus.publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID,
          agent: Agent.ID.make("reviewer"),
          model: { id: Model.ID.make("child"), providerID: Provider.ID.make("test") },
        })
        yield* bus.publish(SessionEvent.Text.Started, { sessionID, assistantMessageID, ordinal: 0 })
        yield* bus.publish(SessionEvent.Text.Ended, { sessionID, assistantMessageID, ordinal: 0, text: childText })
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
        resume: answer,
        wake: (sessionID) => Effect.sync(() => void wakes.push(sessionID)),
        interrupt: () => Effect.succeed(false),
        awaitIdle: () => Effect.void,
      })
    }),
  ),
  deps: [Bus.node],
})

const supervisor = makeLocationNode({
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
    PluginRuntime.node,
    Tool.node,
  ],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
  CodeModeCommand.node,
  CodeModeStore.node,
  CodeModeResume.node,
  Job.node,
  KV.node,
  Session.node,
  SessionStore.node,
  SessionExecution.node,
  SessionRestart.node,
  PluginRuntime.providerNode,
  LocationServiceMap.node,
])

const replacements = [
  [SessionExecution.node, executionNode],
  [Global.node, tempGlobalLayer],
  [PluginSupervisor.node, supervisor],
  [ExternalAgentDrivers.node, noVendorDrivers],
] satisfies LayerNode.Replacements

const it = testEffect(AppNodeBuilder.build(nodes, replacements))

/** Tools whose every run is recorded, so a test can prove which calls ran again after a restart. */
const testTools = (ran: Array<string>, block: Effect.Effect<void> = Effect.void): ReadonlyArray<Tool.Info> => [
  {
    name: "lookup",
    options: { namespace: "test", readOnly: true },
    description: "Looks something up without changing anything.",
    input: Schema.Struct({ query: Schema.String }),
    output: Schema.Struct({ rows: Schema.Number }),
    execute: (input: { readonly query: string }) =>
      Effect.sync(() => {
        ran.push("lookup:" + input.query)
        return { output: { rows: input.query.length } }
      }),
  },
  {
    name: "wait",
    options: { namespace: "test", readOnly: true },
    description: "Waits for something without changing anything.",
    input: Schema.Struct({ step: Schema.Number }),
    output: Schema.Struct({ value: Schema.String }),
    execute: (input: { readonly step: number }) =>
      Effect.sync(() => ran.push("wait:" + input.step)).pipe(
        Effect.andThen(block),
        Effect.as({ output: { value: "ready" } }),
      ),
  },
  {
    name: "write",
    options: { namespace: "test" },
    description: "Writes something somewhere else.",
    input: Schema.Struct({ text: Schema.String }),
    output: Schema.Struct({ id: Schema.String }),
    execute: (input: { readonly text: string }) =>
      Effect.sync(() => {
        ran.push("write:" + input.text)
        return { output: { id: "w-" + input.text } }
      }),
  },
]

const register = (location: Location.Ref, tools: ReadonlyArray<Tool.Info>) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    yield* Effect.gen(function* () {
      const registry = yield* Tool.Service
      const agents = yield* Agent.Service
      yield* registry.transform((draft) => tools.forEach((tool) => draft.add(tool)))
      yield* agents.transform((draft) => {
        draft.update(toolIdentity.agent, (agent) => {
          agent.mode = "primary"
        })
        draft.update(Agent.ID.make("reviewer"), (agent) => {
          agent.mode = "subagent"
        })
      })
    }).pipe(Effect.provide(locations.get(location)))
  })

const withLocation = <A, E, R>(body: (location: Location.Ref) => Effect.Effect<A, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((dir) => body(Location.Ref.make({ directory: AbsolutePath.make(dir.path) }))))

type Call = {
  readonly tool: string
  readonly input: unknown
  readonly impure?: ReadonlyArray<number>
  readonly output?: unknown
  readonly error?: string
  readonly progress?: Readonly<Record<string, unknown>>
}

/**
 * Leaves an execution exactly as a host that stopped mid-run leaves it: admitted, running, and with
 * the journal its calls wrote. A call without an output was still in flight.
 */
const crashed = (
  location: Location.Ref,
  source: string,
  calls: ReadonlyArray<Call>,
  tools?: CodeModeStore.Execution["tools"],
) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const store = yield* CodeModeStore.Service
    const session = yield* sessions.create({ location })
    yield* seedToolSession(session.id, toolIdentity.messageID)
    const admission = yield* store.admit({
      id: "exe_" + session.id.slice(4),
      sessionID: session.id,
      assistantMessageID: toolIdentity.messageID,
      toolCallID: "call_resume",
      program: CodeMode.compile(source),
      ...(tools === undefined ? {} : { tools }),
    })
    if (!admission.ok) return yield* Effect.die(admission.message)
    const executionID = admission.execution.id
    yield* store.running(executionID)
    yield* Effect.forEach(
      calls,
      (call, index) =>
        Effect.gen(function* () {
          yield* store.scheduleCall({ executionID, index, tool: call.tool, input: call.input, impure: call.impure })
          if (call.progress) yield* store.progressCall({ executionID, index, progress: call.progress })
          if (call.output !== undefined)
            yield* store.settleCall({ executionID, index, outcome: "completed", output: call.output })
          if (call.error !== undefined)
            yield* store.settleCall({ executionID, index, outcome: "failed", error: call.error })
        }),
      { discard: true },
    )
    return { session, executionID }
  })

const resume = (executionID: string) =>
  Effect.gen(function* () {
    const resumer = yield* CodeModeResume.Service
    return yield* resumer.resume({ executionID, notificationID: SessionMessage.ID.create() })
  })

const terminals = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const seen: Array<SessionEvent.CodeMode.Completed | SessionEvent.CodeMode.Failed> = []
  yield* bus.project(SessionEvent.CodeMode.Completed, (event) => Effect.sync(() => void seen.push(event)))
  yield* bus.project(SessionEvent.CodeMode.Failed, (event) => Effect.sync(() => void seen.push(event)))
  return seen
})

describe("Code Mode resume", () => {
  it.live("serves settled calls from the journal and runs live from the first unsettled one", () =>
    withLocation((location) =>
      Effect.gen(function* () {
        const ran: Array<string> = []
        yield* register(location, testTools(ran))
        const seen = yield* terminals
        const { session, executionID } = yield* crashed(
          location,
          [
            'const found = tools.test.lookup({ query: "abc" })',
            'const saved = tools.test.write({ text: "x" + found.rows })',
            'const after = tools.test.write({ text: "after" })',
          ].join("\n"),
          [
            { tool: "test.lookup", input: { query: "abc" }, output: { rows: 3 } },
            { tool: "test.write", input: { text: "x3" }, output: { id: "w-x3" } },
          ],
        )

        expect(yield* resume(executionID)).toEqual({ resumed: true })
        const info = yield* waitForCodeModeExecution(CodeModeExecution.ID.make(executionID))

        expect(ran).toEqual(["write:after"])
        expect(info).toMatchObject({ status: "completed", output: expect.stringContaining("replayed 2 journaled") })
        expect(yield* readCodeModeNotebook(session.id)).toEqual({
          found: { rows: 3 },
          saved: { id: "w-x3" },
          after: { id: "w-after" },
        })
        expect(seen).toMatchObject([{ type: "session.codemode.completed", data: { resumed: true } }])
        // Replayed calls stay visible in the trace, marked so they read as recovered rather than rerun.
        expect(seen[0]?.data.events.flatMap((event) => (event.type === "tool" ? [event] : []))).toMatchObject([
          { tool: "test.lookup", status: "completed", replayed: true, output: expect.stringContaining("3") },
          { tool: "test.write", status: "completed", replayed: true },
          { tool: "test.write", status: "completed", output: expect.stringContaining("w-after") },
        ])
        expect(seen[0]?.data.events.filter((event) => event.type === "tool")[2]).not.toHaveProperty("replayed")
      }),
    ),
  )

  it.live("resumes with the tool list it was admitted with, evaluating the same init.ts again", () =>
    withLocation((location) =>
      Effect.gen(function* () {
        const ran: Array<string> = []
        const called: Array<string> = []
        yield* register(location, [
          ...testTools(ran),
          {
            name: "whoami",
            options: { namespace: "test", readOnly: true },
            description: "Returns the call ID it ran as.",
            input: Schema.Struct({}),
            output: Schema.String,
            execute: (_input: unknown, context: Tool.Context) =>
              Effect.sync(() => {
                called.push(context.id)
                return { output: context.id }
              }),
          },
        ])
        // The execution's own init.ts, whatever the Location's is now: this Location has none.
        const init = [
          "let shout = tool.define({",
          '  name: "shout",',
          '  description: "Shout text",',
          '  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },',
          "  outputSchema: {},",
          '  execute: (input) => ({ written: tools.test.write({ text: input.text + "!" }), as: tools.test.whoami({}) }),',
          "})",
          "return { build: [tools.test.lookup, shout] }",
        ].join("\n")
        const { session, executionID } = yield* crashed(
          location,
          ['const found = tools.test.lookup({ query: "abc" })', 'const shouted = tools.shout({ text: "hi" })'].join(
            "\n",
          ),
          [{ tool: "test.lookup", input: { query: "abc" }, output: { rows: 3 } }],
          { init: { source: init, agent: "build" } },
        )

        expect(yield* resume(executionID)).toEqual({ resumed: true })
        const info = yield* waitForCodeModeExecution(CodeModeExecution.ID.make(executionID))
        expect(info.status).toBe("completed")
        expect(ran).toEqual(["write:hi!"])
        // The wrapper's calls are numbered under the execution's second call, as they were before the restart.
        expect(called).toEqual(["call_resume:1:1"])
        expect(yield* readCodeModeNotebook(session.id)).toEqual({
          found: { rows: 3 },
          shouted: { written: { id: "w-hi!" }, as: "call_resume:1:1" },
        })
      }),
    ),
  )

  it.live("replays a journaled failure as the same catchable error", () =>
    withLocation((location) =>
      Effect.gen(function* () {
        const ran: Array<string> = []
        yield* register(location, testTools(ran))
        const { session, executionID } = yield* crashed(
          location,
          [
            'let message = "none"',
            'try { tools.test.write({ text: "refused" }) } catch (error) { message = error.message }',
            "const caught = message",
          ].join("\n"),
          [{ tool: "test.write", input: { text: "refused" }, error: "Write refused by the remote service" }],
        )

        expect(yield* resume(executionID)).toEqual({ resumed: true })
        yield* waitForCodeModeExecution(CodeModeExecution.ID.make(executionID))

        expect(ran).toEqual([])
        expect(yield* readCodeModeNotebook(session.id)).toEqual({ caught: "Write refused by the remote service" })
      }),
    ),
  )

  it.live("feeds journaled time.now values back so replayed inputs match", () =>
    withLocation((location) =>
      Effect.gen(function* () {
        const ran: Array<string> = []
        yield* register(location, testTools(ran))
        const at = 1_700_000_000_000
        const { session, executionID } = yield* crashed(
          location,
          ["const at = time.now()", "const stamped = tools.test.write({ text: String(at) })"].join("\n"),
          [{ tool: "test.write", input: { text: String(at) }, impure: [at], output: { id: "w-" + at } }],
        )

        expect(yield* resume(executionID)).toEqual({ resumed: true })
        yield* waitForCodeModeExecution(CodeModeExecution.ID.make(executionID))

        expect(ran).toEqual([])
        expect(yield* readCodeModeNotebook(session.id)).toEqual({ at, stamped: { id: "w-" + at } })
      }),
    ),
  )

  it.live("settles indeterminate instead of guessing when the program diverges from its journal", () =>
    withLocation((location) =>
      Effect.gen(function* () {
        const ran: Array<string> = []
        yield* register(location, testTools(ran))
        const seen = yield* terminals
        const { session, executionID } = yield* crashed(
          location,
          ['const first = tools.test.write({ text: "one" })', 'const second = tools.test.write({ text: "two" })'].join(
            "\n",
          ),
          [{ tool: "test.write", input: { text: "something else" }, output: { id: "w-else" } }],
        )

        expect(yield* resume(executionID)).toEqual({ resumed: true })
        const info = yield* waitForCodeModeExecution(CodeModeExecution.ID.make(executionID))
        const store = yield* CodeModeStore.Service

        expect(ran).toEqual([])
        expect(info.status).toBe("error")
        expect(yield* store.get(executionID)).toMatchObject({
          status: "indeterminate",
          saved: [],
          error: expect.stringContaining(
            "the program made call 1 (tools.test.write) with different input than it did originally.",
          ),
        })
        expect(yield* readCodeModeNotebook(session.id)).toEqual({})
        expect(seen).toMatchObject([
          {
            type: "session.codemode.failed",
            data: { resumed: true, status: "error", error: expect.stringContaining("diverged") },
          },
        ])
      }),
    ),
  )

  it.live("runs an in-flight read-only call again", () =>
    withLocation((location) =>
      Effect.gen(function* () {
        const ran: Array<string> = []
        yield* register(location, testTools(ran))
        const { session, executionID } = yield* crashed(
          location,
          ['const saved = tools.test.write({ text: "kept" })', "const waited = tools.test.wait({ step: 1 })"].join(
            "\n",
          ),
          [
            { tool: "test.write", input: { text: "kept" }, output: { id: "w-kept" } },
            { tool: "test.wait", input: { step: 1 } },
          ],
        )

        expect(yield* resume(executionID)).toEqual({ resumed: true })
        yield* waitForCodeModeExecution(CodeModeExecution.ID.make(executionID))

        expect(ran).toEqual(["wait:1"])
        expect(yield* readCodeModeNotebook(session.id)).toEqual({
          saved: { id: "w-kept" },
          waited: { value: "ready" },
        })
      }),
    ),
  )

  it.live("never runs an in-flight side-effecting call again and names it instead", () =>
    withLocation((location) =>
      Effect.gen(function* () {
        const ran: Array<string> = []
        yield* register(location, testTools(ran))
        const { session, executionID } = yield* crashed(
          location,
          ['const found = tools.test.lookup({ query: "q" })', 'const saved = tools.test.write({ text: "once" })'].join(
            "\n",
          ),
          [
            { tool: "test.lookup", input: { query: "q" }, output: { rows: 1 } },
            { tool: "test.write", input: { text: "once" } },
          ],
        )
        const store = yield* CodeModeStore.Service

        const outcome = yield* resume(executionID)

        expect(outcome).toEqual({
          resumed: false,
          reason: expect.stringContaining(
            "Call 2 (tools.test.write) was running when the server stopped, so it may or may not have taken effect, and it is not safe to run again automatically.",
          ),
        })
        expect(ran).toEqual([])
        expect(yield* store.get(executionID)).toMatchObject({ status: "indeterminate", saved: [] })
        expect(yield* store.reservations(session.id)).toEqual([])
      }),
    ),
  )

  it.live("rejoins the child session of an in-flight subagent call instead of starting another", () =>
    withLocation((location) =>
      Effect.gen(function* () {
        yield* register(location, [])
        const sessions = yield* Session.Service
        const call = { agent: "reviewer", description: "review", message: "check it" }
        const { session, executionID } = yield* crashed(
          location,
          "const review = tools.subagent(" + JSON.stringify(call) + ")",
          [],
        )
        const child = yield* sessions.create({
          parentID: session.id,
          title: "review",
          agent: Agent.ID.make("reviewer"),
        })
        const store = yield* CodeModeStore.Service
        yield* store.scheduleCall({ executionID, index: 0, tool: "subagent", input: call })
        yield* store.progressCall({ executionID, index: 0, progress: { sessionID: child.id, status: "running" } })

        expect(yield* resume(executionID)).toEqual({ resumed: true })
        const info = yield* waitForCodeModeExecution(CodeModeExecution.ID.make(executionID))

        expect(info.status).toBe("completed")
        expect((yield* sessions.list({ parentID: session.id })).data.map((item) => item.id)).toEqual([child.id])
        expect(yield* readCodeModeNotebook(session.id)).toEqual({
          review: { sessionID: child.id, status: "completed", message: childText, output: null },
        })
        // The child is told to continue instead of receiving its task a second time.
        const database = yield* Database.Service
        expect(yield* SessionInbox.list(database.db, child.id)).toMatchObject([
          {
            type: "synthetic",
            payload: { text: expect.stringContaining("The server restarted while you were working on this task.") },
          },
        ])
      }),
    ),
  )
})

/**
 * A host process over one database file: each call boots a fresh runtime and tears it down when the
 * effect ends, which stops every running execution the way a shutdown does.
 */
const hostProcess = (file: string) => {
  const runtime = AppNodeBuilder.build(nodes, [...replacements, [Database.node, Database.configured({ path: file })]])
  return <A, E>(effect: Effect.Effect<A, E, Layer.Success<typeof runtime> | Scope.Scope>) =>
    Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(runtime)))
}

/** Registers the test tools with a `tools.test.wait` that never returns, and a signal that opens on its first call. */
const registerBlocked = (location: Location.Ref, ran: Array<string>) =>
  Effect.gen(function* () {
    const blocked = yield* Deferred.make<void>()
    yield* register(location, testTools(ran, Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Effect.never))))
    return blocked
  })

/** Starts a program the way the runner starts a model's `execute` call, and returns its execution ID. */
const start = (location: Location.Ref, sessionID: Session.ID, id: string, code: string) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(location)))
    const toolSet = yield* registry.snapshot(undefined, sessionID)
    const launched = yield* toolSet.execute({
      sessionID,
      ...toolIdentity,
      call: { type: "tool-call", id, name: "execute", input: { code } },
    })
    return yield* activateCodeMode(launched.output, { sessionID, assistantMessageID: toolIdentity.messageID, id })
  })

/** Creates a Session with the assistant message that model-started executions belong to. */
const createSession = (location: Location.Ref) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const session = yield* sessions.create({ location })
    yield* seedToolSession(session.id, toolIdentity.messageID)
    return session.id
  })

/** Runs restart recovery the way a host does at boot. */
const restart = Effect.gen(function* () {
  const recovery = yield* SessionRestart.Service
  yield* recovery.resumeSuspendedSessions
})

const inbox = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const database = yield* Database.Service
    return yield* SessionInbox.list(database.db, sessionID)
  })

// Serves the demo store document only after a delay, like a spec server that is slow at startup, and
// records every API request.
const storeRequests: Array<string> = []
const specs = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/openapi.json") {
      await Bun.sleep(500)
      return new Response(Bun.file(path.join(import.meta.dir, "fixtures", "openapi-store.json")))
    }
    storeRequests.push(request.method + " " + url.pathname + url.search)
    return Response.json([{ id: "1", name: "desk" }])
  },
})
afterAll(() => specs.stop(true))

describe("Code Mode crash recovery", () => {
  test("rebuilds inventory and direct-reference inspection on a fresh host runtime", async () => {
    await using dir = await tmpdir()
    const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
    const run = hostProcess(path.join(dir.path, "ocpp.db"))
    const started = await run(
      Effect.gen(function* () {
        const blocked = yield* registerBlocked(location, [])
        const sessionID = yield* createSession(location)
        const saved = yield* start(
          location,
          sessionID,
          "call_notebook_save",
          "const savedData = { answer: 42 }; function savedHelper(x) { return savedData.answer + x }",
        )
        yield* waitForCodeModeExecution(saved)
        const executionID = yield* start(
          location,
          sessionID,
          "call_notebook_inspect",
          "let metadata = tools.notebook.inspect({ value: savedHelper }); tools.test.wait({ step: 1 }); return metadata",
        )
        yield* Deferred.await(blocked)
        return { sessionID, executionID }
      }),
    )
    const recovered = await run(
      Effect.gen(function* () {
        yield* register(location, testTools([]))
        yield* restart
        const info = yield* waitForCodeModeExecution(started.executionID)
        const notebook = yield* CodeModeStore.Service
        const names = yield* CodeModeStore.savedNames((yield* Database.Service).db, started.sessionID)
        return { info, inventory: yield* CodeModeInstructions.notebook(notebook, started.sessionID, names) }
      }),
    )
    expect(recovered.info).toMatchObject({ status: "completed" })
    expect(recovered.info.output).toContain("function savedHelper(x)")
    expect(recovered.info.output).toContain("savedData")
    expect(recovered.inventory).toContain("2 saved identifiers; 0 omitted")
    expect(recovered.inventory).toContain("function savedHelper(x)")
  })

  test("a run torn down mid-call resumes on a fresh runtime without calling completed tools again", async () => {
    await using dir = await tmpdir()
    const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
    const run = hostProcess(path.join(dir.path, "ocpp.db"))
    const source = [
      "const at = time.now()",
      'const first = tools.test.write({ text: "first@" + at })',
      "const waited = tools.test.wait({ step: 1 })",
      'const second = tools.test.write({ text: "second:" + waited.value })',
    ].join("\n")

    const before: Array<string> = []
    const started = await run(
      Effect.gen(function* () {
        const blocked = yield* registerBlocked(location, before)
        const sessionID = yield* createSession(location)
        const executionID = yield* start(location, sessionID, "call_crash", source)
        // The runtime is torn down while the program waits inside its second call.
        yield* Deferred.await(blocked)
        return { sessionID, executionID }
      }),
    )
    expect(before).toEqual([expect.stringMatching(/^write:first@\d+$/), "wait:1"])

    const after: Array<string> = []
    const recovered = await run(
      Effect.gen(function* () {
        yield* register(location, testTools(after))
        yield* restart
        const info = yield* waitForCodeModeExecution(started.executionID)
        const store = yield* CodeModeStore.Service
        return {
          info,
          execution: yield* store.get(started.executionID),
          notebook: yield* readCodeModeNotebook(started.sessionID),
          inbox: yield* inbox(started.sessionID),
        }
      }),
    )

    // The completed write is served from the journal; only the interrupted read-only wait and the
    // calls after it run on the fresh runtime.
    expect(after).toEqual(["wait:1", "write:second:ready"])
    expect(recovered.info.status).toBe("completed")
    expect(recovered.execution).toMatchObject({ status: "saved", saved: ["at", "first", "waited", "second"] })
    const at = recovered.notebook.at
    expect(before[0]).toBe("write:first@" + at)
    expect(recovered.notebook).toEqual({
      at,
      first: { id: "w-first@" + at },
      waited: { value: "ready" },
      second: { id: "w-second:ready" },
    })
    // The completion notification reaches the model exactly as for a run that never stopped.
    expect(recovered.inbox).toMatchObject([
      {
        type: "synthetic",
        payload: {
          text: expect.stringContaining("resumed after a server restart and replayed 1 journaled tool call"),
          metadata: { source: "codemode", executionID: started.executionID, state: "completed" },
        },
      },
    ])
  })

  test("a run in a subagent placed at another root resumes in that root's Location", async () => {
    await using dir = await tmpdir()
    await using worktree = await tmpdir()
    const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
    const root = Location.Ref.make({ directory: AbsolutePath.make(worktree.path) })
    const run = hostProcess(path.join(dir.path, "ocpp.db"))
    const source = [
      'const first = tools.test.write({ text: "first" })',
      "const waited = tools.test.wait({ step: 1 })",
    ].join("\n")

    const before: Array<string> = []
    const started = await run(
      Effect.gen(function* () {
        // Only the root's Location has the test tools, so a run resumed anywhere else could not call them.
        const blocked = yield* registerBlocked(root, before)
        const sessions = yield* Session.Service
        const parent = yield* sessions.create({ location })
        // Placed the way a subagent call with `root` places its child.
        const child = yield* sessions.create({ parentID: parent.id, location: root })
        yield* seedToolSession(child.id, toolIdentity.messageID)
        const executionID = yield* start(root, child.id, "call_rooted", source)
        yield* Deferred.await(blocked)
        return { sessionID: child.id, executionID }
      }),
    )
    expect(before).toEqual(["write:first", "wait:1"])

    const after: Array<string> = []
    const recovered = await run(
      Effect.gen(function* () {
        yield* register(root, testTools(after))
        yield* restart
        return {
          info: yield* waitForCodeModeExecution(started.executionID),
          notebook: yield* readCodeModeNotebook(started.sessionID),
        }
      }),
    )
    // The completed write is served from the journal; the interrupted wait runs again at the root.
    expect(after).toEqual(["wait:1"])
    expect(recovered.info.status).toBe("completed")
    expect(recovered.notebook).toEqual({ first: { id: "w-first" }, waited: { value: "ready" } })
  })

  test("a command run stopped by a restart resumes and reports to history without waking the model", async () => {
    await using dir = await tmpdir()
    const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
    const run = hostProcess(path.join(dir.path, "ocpp.db"))

    const before: Array<string> = []
    const started = await run(
      Effect.gen(function* () {
        const blocked = yield* registerBlocked(location, before)
        const sessionID = yield* createSession(location)
        const defined = yield* start(
          location,
          sessionID,
          "call_define",
          [
            "function slow(input) {",
            "  const found = tools.test.lookup({ query: input.text })",
            "  return tools.test.wait({ step: found.rows })",
            "}",
          ].join("\n"),
        )
        expect((yield* waitForCodeModeExecution(defined)).status).toBe("completed")
        const commands = yield* CodeModeCommand.Service
        yield* commands.define(sessionID, {
          name: "slow",
          description: "Looks up the text, then waits.",
          handler: "slow",
        })
        const sessions = yield* Session.Service
        yield* sessions.command({ sessionID, command: "slow", text: "go" })
        // The runtime is torn down while the command's handler waits inside its second call.
        yield* Deferred.await(blocked)
        const invocation = (yield* sessions.messages({ sessionID, order: "asc" })).find(
          (message) => message.type === "invocation",
        )
        if (invocation?.type !== "invocation") return yield* Effect.die("Expected an invocation message")
        return { sessionID, executionID: invocation.executionID }
      }),
    )
    expect(before).toEqual(["lookup:go", "wait:2"])

    const after: Array<string> = []
    wakes.length = 0
    const recovered = await run(
      Effect.gen(function* () {
        yield* register(location, testTools(after))
        yield* restart
        const info = yield* waitForCodeModeExecution(started.executionID)
        const store = yield* CodeModeStore.Service
        const sessions = yield* Session.Service
        return {
          info,
          execution: yield* store.get(started.executionID),
          invocation: (yield* sessions.messages({ sessionID: started.sessionID, order: "asc" })).find(
            (message) => message.type === "invocation",
          ),
          inbox: yield* inbox(started.sessionID),
        }
      }),
    )

    // The lookup is served from the journal and only the interrupted read-only wait runs again.
    expect(after).toEqual(["wait:2"])
    expect(recovered.info.status).toBe("completed")
    expect(recovered.execution).toMatchObject({ status: "saved" })
    expect(recovered.invocation).toMatchObject({ type: "invocation", status: "completed" })
    // The outcome waits in the inbox for the model's next turn, as for a command that never stopped.
    expect(
      recovered.inbox.find(
        (item) => item.type === "synthetic" && item.payload.metadata?.executionID === started.executionID,
      ),
    ).toMatchObject({
      type: "synthetic",
      payload: {
        description: "/slow",
        text: expect.stringMatching(
          /^The user ran the command \/slow with the text "go"\.\n.*replayed 1 journaled tool call/s,
        ),
        metadata: { source: "codemode", state: "completed" },
      },
    })
    expect(wakes).not.toContain(started.sessionID)
  })

  test("stops resuming a run after three restarts that each stopped it again", async () => {
    await using dir = await tmpdir()
    const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
    const run = hostProcess(path.join(dir.path, "ocpp.db"))
    const ran: Array<string> = []

    const started = await run(
      Effect.gen(function* () {
        const blocked = yield* registerBlocked(location, ran)
        const sessionID = yield* createSession(location)
        const executionID = yield* start(
          location,
          sessionID,
          "call_loop",
          ['const found = tools.test.lookup({ query: "q" })', "const waited = tools.test.wait({ step: 1 })"].join("\n"),
        )
        yield* Deferred.await(blocked)
        return { sessionID, executionID }
      }),
    )
    // Each restart resumes the run, which stops again inside the same read-only call.
    for (const _ of [1, 2, 3])
      await run(
        Effect.gen(function* () {
          const blocked = yield* registerBlocked(location, ran)
          yield* restart
          yield* Deferred.await(blocked)
        }),
      )
    const settled = await run(
      Effect.gen(function* () {
        yield* register(location, testTools(ran))
        yield* restart
        const store = yield* CodeModeStore.Service
        return {
          execution: yield* store.get(started.executionID),
          reservations: yield* store.reservations(started.sessionID),
          inbox: yield* inbox(started.sessionID),
        }
      }),
    )

    expect(ran).toEqual(["lookup:q", "wait:1", "wait:1", "wait:1", "wait:1"])
    expect(settled.execution).toMatchObject({
      status: "indeterminate",
      saved: [],
      error: expect.stringContaining("It was already resumed 3 times without settling."),
    })
    expect(settled.reservations).toEqual([])
    expect(settled.inbox).toMatchObject([
      {
        type: "synthetic",
        payload: {
          text: expect.stringContaining("It was already resumed 3 times without settling."),
          metadata: { source: "codemode", executionID: started.executionID, state: "failed" },
        },
      },
    ])
  })

  test("a run that called an OpenAPI tool resumes once its document loads, and searches the catalog live", async () => {
    await using dir = await tmpdir()
    const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
    const run = hostProcess(path.join(dir.path, "ocpp.db"))
    await Bun.write(
      path.join(dir.path, "ocpp.json"),
      JSON.stringify({
        openapi: {
          store: {
            spec: "http://127.0.0.1:" + specs.port + "/openapi.json",
            base_url: "http://127.0.0.1:" + specs.port,
            headers: { "X-Api-Key": "demo-key" },
          },
        },
      }),
    )
    storeRequests.length = 0
    const source = [
      'const found = tools.search({ namespace: "store" })',
      "const items = tools.store.listItems({ limit: 1 })",
      "const waited = tools.test.wait({ step: items.length })",
    ].join("\n")

    const before: Array<string> = []
    const started = await run(
      Effect.gen(function* () {
        const blocked = yield* registerBlocked(location, before)
        const locations = yield* LocationServiceMap.Service
        yield* Effect.gen(function* () {
          const openapi = yield* OpenApi.Service
          yield* openapi.flush
        }).pipe(Effect.provide(locations.get(location)))
        const sessionID = yield* createSession(location)
        const executionID = yield* start(location, sessionID, "call_openapi", source)
        yield* Deferred.await(blocked)
        return { sessionID, executionID }
      }),
    )
    expect(storeRequests).toEqual(["GET /items?limit=1"])

    const after: Array<string> = []
    const recovered = await run(
      Effect.gen(function* () {
        // The document is still loading when recovery starts, so resuming must wait for it.
        yield* register(location, testTools(after))
        const seen = yield* terminals
        yield* restart
        const info = yield* waitForCodeModeExecution(started.executionID)
        return { info, seen, notebook: yield* readCodeModeNotebook(started.sessionID) }
      }),
    )

    expect(storeRequests).toEqual(["GET /items?limit=1"])
    expect(after).toEqual(["wait:1"])
    expect(recovered.info).toMatchObject({
      status: "completed",
      output: expect.stringContaining("replayed 1 journaled tool call "),
    })
    expect(recovered.notebook).toMatchObject({ items: [{ id: "1", name: "desk" }], waited: { value: "ready" } })
    // tools.search runs inside the interpreter again, so it is neither served nor counted as replayed.
    const calls = recovered.seen[0]?.data.events.flatMap((event) => (event.type === "tool" ? [event] : []))
    expect(calls).toMatchObject([
      { tool: "search", status: "completed" },
      { tool: "store.listItems", status: "completed", replayed: true },
      { tool: "test.wait", status: "completed" },
    ])
    expect(calls?.[0]).not.toHaveProperty("replayed")
    expect(calls?.[2]).not.toHaveProperty("replayed")
  }, 30_000)
})
