import { describe, expect, test } from "bun:test"
import path from "path"
import { CodeMode } from "@ocpp/codemode"
import { CodeModeExecution } from "@ocpp/schema/codemode-execution"
import { Money } from "@ocpp/schema/money"
import { Deferred, Effect, Layer, Schema } from "effect"
import { Agent } from "@ocpp/core/agent"
import { Bus } from "@ocpp/core/bus"
import { Catalog } from "@ocpp/core/catalog"
import { CodeModeResume } from "@ocpp/core/codemode/resume"
import { CodeModeStore } from "@ocpp/core/codemode/store"
import { Config } from "@ocpp/core/config"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { Job } from "@ocpp/core/job"
import { KV } from "@ocpp/core/kv"
import { Location } from "@ocpp/core/location"
import { LocationServiceMap } from "@ocpp/core/location-service-map"
import { Model } from "@ocpp/core/model"
import { Permission } from "@ocpp/core/permission"
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
import { makeGlobalNode, makeLocationNode } from "@ocpp/util/effect/app-node"
import { LayerNode } from "@ocpp/util/effect/layer-node"
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
        wake: () => Effect.void,
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
  deps: [Agent.node, Bus.node, Catalog.node, Config.node, Permission.node, PluginRuntime.node, Tool.node],
})

const nodes = LayerNode.group([
  Database.node,
  Bus.node,
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
          agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
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
const crashed = (location: Location.Ref, source: string, calls: ReadonlyArray<Call>) =>
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

describe("Code Mode crash recovery", () => {
  test("a run torn down mid-call resumes on a fresh runtime without calling completed tools again", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "ocpp.db")
    const location = Location.Ref.make({ directory: AbsolutePath.make(dir.path) })
    const runtime = AppNodeBuilder.build(nodes, [...replacements, [Database.node, Database.configured({ path: file })]])
    const source = [
      "const at = time.now()",
      'const first = tools.test.write({ text: "first@" + at })',
      "const waited = tools.test.wait({ step: 1 })",
      'const second = tools.test.write({ text: "second:" + waited.value })',
    ].join("\n")

    const before: Array<string> = []
    const started = await Effect.runPromise(
      Effect.gen(function* () {
        const blocked = yield* Deferred.make<void>()
        yield* register(
          location,
          testTools(before, Deferred.succeed(blocked, undefined).pipe(Effect.andThen(Effect.never))),
        )
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ location })
        yield* seedToolSession(session.id, toolIdentity.messageID)
        const locations = yield* LocationServiceMap.Service
        const registry = yield* Tool.Service.pipe(Effect.provide(locations.get(location)))
        const toolSet = yield* registry.snapshot(undefined, session.id)
        const launched = yield* toolSet.execute({
          sessionID: session.id,
          ...toolIdentity,
          call: { type: "tool-call", id: "call_crash", name: "execute", input: { code: source } },
        })
        const executionID = yield* activateCodeMode(launched.output, {
          sessionID: session.id,
          assistantMessageID: toolIdentity.messageID,
          id: "call_crash",
        })
        // The runtime is torn down while the program waits inside its second call.
        yield* Deferred.await(blocked)
        return { sessionID: session.id, executionID }
      }).pipe(Effect.scoped, Effect.provide(runtime)),
    )
    expect(before).toEqual([expect.stringMatching(/^write:first@\d+$/), "wait:1"])

    const after: Array<string> = []
    const recovered = await Effect.runPromise(
      Effect.gen(function* () {
        yield* register(location, testTools(after))
        const restart = yield* SessionRestart.Service
        yield* restart.resumeSuspendedSessions
        const info = yield* waitForCodeModeExecution(started.executionID)
        const store = yield* CodeModeStore.Service
        const database = yield* Database.Service
        return {
          info,
          execution: yield* store.get(started.executionID),
          notebook: yield* readCodeModeNotebook(started.sessionID),
          inbox: yield* SessionInbox.list(database.db, started.sessionID),
        }
      }).pipe(Effect.scoped, Effect.provide(runtime)),
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
})
