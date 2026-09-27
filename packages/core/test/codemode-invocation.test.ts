import { describe, expect, test } from "bun:test"
import { Clock, Deferred, Effect, Exit, Layer, Schema, Scope } from "effect"
import { TestClock } from "effect/testing"
import { Agent } from "@ocpp/core/agent"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Database } from "@ocpp/core/database/database"
import { Bus } from "@ocpp/core/bus"
import { CodeModeCommand } from "@ocpp/core/codemode/command"
import { CodeModeEvent } from "@ocpp/core/codemode/event"
import { CodeModeScheduler } from "@ocpp/core/codemode/scheduler"
import { CodeModeStore } from "@ocpp/core/codemode/store"
import { Job } from "@ocpp/core/job"
import { Location } from "@ocpp/core/location"
import { LocationServiceMap } from "@ocpp/core/location-services"
import { Model } from "@ocpp/core/model"
import { PluginRuntime } from "@ocpp/core/plugin/runtime"
import { PluginSupervisor } from "@ocpp/core/plugin/supervisor-service"
import { Project } from "@ocpp/core/project"
import { Provider } from "@ocpp/core/provider"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { SessionEnvironment } from "@ocpp/core/session/environment"
import { SessionEvent } from "@ocpp/core/session/event"
import { SessionExecution } from "@ocpp/core/session/execution"
import { SessionMessage } from "@ocpp/core/session/message"
import { SessionModelTransport } from "@ocpp/core/session/model-transport"
import { SessionProjector } from "@ocpp/core/session/projector"
import { SessionStore } from "@ocpp/core/session/store"
import { Tool } from "@ocpp/core/tool"
import { CodeModeExecution } from "@ocpp/schema/codemode-execution"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { tmpdirScoped } from "./fixture/tmpdir"

const wakes: Session.ID[] = []
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    isActive: () => Effect.succeed(false),
    resume: () => Effect.void,
    wake: (sessionID) => Effect.sync(() => void wakes.push(sessionID)),
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
  }),
)
const transport = Layer.succeed(
  SessionModelTransport.Service,
  SessionModelTransport.Service.of({
    bind: () => ({ execute: () => Effect.die("Unexpected WebSocket execution") }),
    close: () => Effect.void,
    closeAll: Effect.void,
  }),
)

const nodes = [
  Database.node,
  Bus.node,
  SessionProjector.node,
  SessionStore.node,
  SessionEnvironment.node,
  Job.node,
  Session.node,
  LocationServiceMap.node,
  PluginRuntime.providerNode,
  CodeModeCommand.node,
  CodeModeEvent.node,
  CodeModeStore.node,
] as const
const replacements = [
  [Project.node, globalProjectNode],
  [SessionExecution.node, execution],
  [SessionModelTransport.node, transport],
] as const
const it = testEffect(AppNodeBuilder.build(LayerNode.group(nodes), [...replacements]))
const scheduled = testEffect(
  AppNodeBuilder.build(LayerNode.group([...nodes, CodeModeScheduler.node]), [...replacements]),
)

const decodeStarted = Schema.decodeUnknownSync(Schema.Struct({ executionID: CodeModeExecution.ID }))

/** Creates a Session in a fresh directory with its Location services ready. */
const setup = Effect.gen(function* () {
  const directory = yield* tmpdirScoped()
  const sessions = yield* Session.Service
  const session = yield* sessions.create({
    location: Location.Ref.make({ directory: AbsolutePath.make(directory.path) }),
  })
  const locations = yield* LocationServiceMap.Service
  const within = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const plugins = yield* PluginSupervisor.Service
      yield* plugins.flush
      return yield* effect
    }).pipe(Effect.provide(locations.get(session.location)))
  return { session, within }
})

type Setup = Effect.Success<typeof setup>

/** Runs a program the way the runner runs a model's `execute` call, and waits for it to settle. */
const execute = Effect.fnUntraced(function* (context: Setup, code: string) {
  const sessionID = context.session.id
  const bus = yield* Bus.Service
  const jobs = yield* Job.Service
  const assistantMessageID = SessionMessage.ID.create()
  const id = "call_" + assistantMessageID
  yield* bus.publish(SessionEvent.Step.Started, {
    sessionID,
    assistantMessageID,
    agent: Agent.ID.make("build"),
    model: { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") },
  })
  yield* bus.publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID, id, name: "execute" })
  yield* bus.publish(SessionEvent.Tool.Called, { sessionID, assistantMessageID, id, input: { code }, executed: false })
  const result = yield* context.within(
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const registry = yield* Tool.Service
      const agent = yield* agents.select()
      const snapshot = yield* registry.snapshot(agent.info?.permissions, sessionID)
      return yield* snapshot.execute({
        sessionID,
        agent: agent.id,
        messageID: assistantMessageID,
        call: { type: "tool-call", id, name: "execute", input: { code } },
      })
    }),
  )
  yield* bus.publish(SessionEvent.Tool.Success, {
    sessionID,
    assistantMessageID,
    id,
    content: [{ type: "text", text: "started" }],
    executed: false,
  })
  const executionID = decodeStarted(result.output).executionID
  const settled = yield* jobs.wait({ id: executionID })
  yield* notification(sessionID, executionID)
  return settled.info
})

/** Waits for an execution's completion notification to be admitted to the Session inbox. */
const notification = (sessionID: Session.ID, executionID: string) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    return yield* eventually(
      sessions
        .inbox(sessionID)
        .pipe(
          Effect.map((items) =>
            items
              .flatMap((item) =>
                item.type === "synthetic" && item.payload.metadata?.executionID === executionID ? [item.payload] : [],
              )
              .at(0),
          ),
        ),
    )
  })

/** Polls until `check` returns a value. Completions arrive from background fibers, and waiting on a real
 * macrotask keeps this usable under the test clock. */
const eventually = <A, E, R>(check: Effect.Effect<A | undefined, E, R>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt++) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))
    }
    return yield* Effect.die(new Error("condition never held"))
  })

const invocations = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const messages = yield* sessions.messages({ sessionID, order: "asc" })
    return messages.filter((message): message is SessionMessage.Invocation => message.type === "invocation")
  })

/** Waits until `count` invocations exist and every one has settled. */
const settled = (sessionID: Session.ID, count: number) =>
  eventually(
    invocations(sessionID).pipe(
      Effect.map((list) =>
        list.length === count && list.every((item) => item.status !== "running") ? list : undefined,
      ),
    ),
  )

/** Settles Location startup under the test clock, whose plugin loading debounces on the clock. */
const warm = (context: Setup) =>
  Effect.gen(function* () {
    const fiber = yield* context.within(Effect.void).pipe(Effect.forkScoped)
    yield* eventually(TestClock.adjust("100 millis").pipe(Effect.map(() => fiber.pollUnsafe())))
    return yield* Clock.currentTimeMillis
  })

/** Registers `tools.hold()`, which blocks until the returned gate opens. */
const hold = (context: Setup) =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    yield* context.within(
      Effect.gen(function* () {
        const registry = yield* Tool.Service
        yield* registry.transform((draft) =>
          draft.add({
            name: "hold",
            description: "Wait for the test to release",
            input: Schema.Struct({}),
            output: Schema.String,
            execute: () => Deferred.await(gate).pipe(Effect.as({ output: "released" })),
          }),
        )
      }),
    )
    return gate
  })

describe("Code Mode commands", () => {
  it.live("defines, lists, replaces, and removes commands", () =>
    Effect.gen(function* () {
      const context = yield* setup
      const commands = yield* CodeModeCommand.Service
      const first = yield* execute(
        context,
        [
          "function triage(input) { return input.text }",
          "function summarize(input) { return input.text.length }",
          'tools.command.define({ name: "triage", handler: "triage" })',
          'tools.command.define({ name: "summary", description: "Summarize", handler: "summarize" })',
          "return tools.command.list({})",
        ].join("\n"),
      )
      expect(first?.output).toContain('"handler":"summarize"')
      expect(yield* commands.list(context.session.id)).toEqual([
        { name: "summary", description: "Summarize", handler: "summarize" },
        { name: "triage", description: "", handler: "triage" },
      ])

      const second = yield* execute(
        context,
        [
          'tools.command.define({ name: "triage", description: "Now summarizes", handler: "summarize" })',
          'return tools.command.remove({ name: "summary" })',
        ].join("\n"),
      )
      expect(second?.output).toContain('{"removed":true}')
      expect(yield* commands.list(context.session.id)).toEqual([
        { name: "triage", description: "Now summarizes", handler: "summarize" },
      ])
    }),
  )

  it.live("rejects a handler that is not a notebook function", () =>
    Effect.gen(function* () {
      const context = yield* setup
      const commands = yield* CodeModeCommand.Service
      const missing = yield* execute(context, 'tools.command.define({ name: "triage", handler: "triage" })')
      expect(missing?.status).toBe("error")
      expect(missing?.error).toContain("The notebook has no function named triage")
      yield* execute(context, 'const notes = "text"')
      const value = yield* execute(context, 'tools.command.define({ name: "notes", handler: "notes" })')
      expect(value?.error).toContain("Notebook value notes is not a function")
      const name = yield* execute(context, 'tools.command.define({ name: "two words", handler: "notes" })')
      expect(name?.error).toContain('Name "two words" must be 1 to 64 letters')
      expect(yield* commands.list(context.session.id)).toEqual([])
    }),
  )

  it.live("runs a command's handler with the prompt text without waking the model", () =>
    Effect.gen(function* () {
      const context = yield* setup
      const session = context.session
      const sessions = yield* Session.Service
      const defined = yield* execute(
        context,
        [
          'function triage(input) { return "triaged " + input.command + ": " + input.text }',
          'return tools.command.define({ name: "triage", description: "Triage a bug", handler: "triage" })',
        ].join("\n"),
      )
      expect(defined?.status).toBe("completed")

      wakes.length = 0
      yield* sessions.command({ sessionID: session.id, command: "triage", text: "login fails" })
      const [invocation] = yield* settled(session.id, 1)
      expect(invocation).toMatchObject({
        trigger: { type: "command", name: "triage", text: "login fails" },
        code: 'return triage({"text":"login fails","command":"triage"})',
        status: "completed",
      })
      expect(invocation!.events).toContainEqual({ type: "trace", kind: "return", value: "triaged triage: login fails" })
      const outcome = yield* notification(session.id, invocation!.executionID)
      expect(outcome.text).toContain('The user ran the command /triage with the text "login fails".')
      expect(outcome.text).toContain("triaged triage: login fails")
      expect(outcome.description).toBe("/triage")
      expect(wakes).toEqual([])
    }),
  )

  it.live("reports a handler that left the notebook when the command runs", () =>
    Effect.gen(function* () {
      const context = yield* setup
      const sessions = yield* Session.Service
      const store = yield* CodeModeStore.Service
      yield* execute(
        context,
        [
          "function triage(input) { return input.text }",
          'tools.command.define({ name: "triage", handler: "triage" })',
        ].join("\n"),
      )
      // A committed revert removes notebook values saved from its boundary onward.
      yield* store.revert({ sessionID: context.session.id, beforeSeq: 0 })
      const error = yield* sessions
        .command({ sessionID: context.session.id, command: "triage", text: "x" })
        .pipe(Effect.flip)
      expect(error.message).toBe(
        "/triage could not run: The notebook has no function named triage. Save it with a top-level function declaration first.",
      )
      expect(yield* invocations(context.session.id)).toEqual([])
    }),
  )
})

describe("Code Mode events", () => {
  it.live("triggers an event with its input and records the firing", () =>
    Effect.gen(function* () {
      const context = yield* setup
      const events = yield* CodeModeEvent.Service
      yield* execute(
        context,
        [
          'function watch(input) { return input.event + " saw " + input.input.repo }',
          'tools.event.define({ name: "watch", schedule: { every: "1h" }, handler: "watch", input: { repo: "ocpp" } })',
        ].join("\n"),
      )
      wakes.length = 0
      const triggered = yield* execute(context, 'return tools.event.trigger({ name: "watch" })')
      expect(triggered?.output).toContain('"status":"started"')
      const [invocation] = yield* settled(context.session.id, 1)
      expect(invocation).toMatchObject({ trigger: { type: "event", name: "watch" }, status: "completed" })
      expect(invocation!.code).toStartWith('return watch({"event":"watch","firedAt":"')
      const outcome = yield* notification(context.session.id, invocation!.executionID)
      expect(outcome.text).toContain("The event watch fired.")
      expect(outcome.text).toContain("watch saw ocpp")
      // Only the program that triggered the event woke the model; the firing did not.
      expect(wakes).toEqual([context.session.id])

      const manual = yield* execute(context, 'return tools.event.trigger({ name: "watch", input: { repo: "other" } })')
      expect(manual?.status).toBe("completed")
      yield* settled(context.session.id, 2)
      const [info] = yield* events.list(context.session.id)
      expect(info).toMatchObject({
        name: "watch",
        enabled: true,
        lastStatus: "completed",
        lastSummary: "watch saw other",
        runCount: 2,
        skipCount: 0,
      })
    }),
  )

  it.live("skips a firing while the previous one is still running", () =>
    Effect.gen(function* () {
      const context = yield* setup
      const events = yield* CodeModeEvent.Service
      const gate = yield* hold(context)
      yield* execute(
        context,
        [
          "function slow(input) { return tools.hold({}) }",
          'tools.event.define({ name: "slow", schedule: { every: "1h" }, handler: "slow" })',
        ].join("\n"),
      )
      const first = yield* execute(context, 'return tools.event.trigger({ name: "slow" })')
      expect(first?.output).toContain('"status":"started"')
      const second = yield* execute(context, 'return tools.event.trigger({ name: "slow" })')
      expect(second?.output).toContain('"status":"skipped"')
      expect(yield* events.list(context.session.id)).toMatchObject([
        { name: "slow", lastStatus: "running", runCount: 1, skipCount: 1 },
      ])

      yield* Deferred.succeed(gate, undefined)
      yield* settled(context.session.id, 1)
      expect(yield* events.list(context.session.id)).toMatchObject([
        { name: "slow", lastStatus: "completed", lastSummary: "released", runCount: 1, skipCount: 1 },
      ])
      const third = yield* execute(context, 'return tools.event.trigger({ name: "slow" })')
      expect(third?.output).toContain('"status":"started"')
    }),
  )

  it.live("records a firing whose handler left the notebook", () =>
    Effect.gen(function* () {
      const context = yield* setup
      const events = yield* CodeModeEvent.Service
      const store = yield* CodeModeStore.Service
      const missing = yield* execute(
        context,
        'tools.event.define({ name: "watch", schedule: { every: "1h" }, handler: "watch" })',
      )
      expect(missing?.error).toContain("The notebook has no function named watch")
      yield* execute(
        context,
        [
          "function watch(input) { return 1 }",
          'tools.event.define({ name: "watch", schedule: { every: "1h" }, handler: "watch" })',
        ].join("\n"),
      )
      yield* store.revert({ sessionID: context.session.id, beforeSeq: 0 })
      const fired = yield* execute(context, 'return tools.event.trigger({ name: "watch" })')
      expect(fired?.error).toContain("The notebook has no function named watch")
      expect(yield* events.list(context.session.id)).toMatchObject([
        {
          name: "watch",
          lastStatus: "error",
          lastSummary: "The notebook has no function named watch. Save it with a top-level function declaration first.",
          runCount: 1,
        },
      ])
    }),
  )

  scheduled.effect("fires on its interval and follows disable and enable", () =>
    Effect.gen(function* () {
      const context = yield* setup
      const start = yield* warm(context)
      const at = (millis: number) => new Date(start + millis).toISOString()
      const events = yield* CodeModeEvent.Service
      yield* execute(
        context,
        [
          "function tick(input) { return input.firedAt }",
          'tools.event.define({ name: "tick", schedule: { every: "1m" }, handler: "tick" })',
        ].join("\n"),
      )
      const [defined] = yield* events.list(context.session.id)
      expect(defined?.nextFireAt).toBe(at(60_000))

      yield* TestClock.adjust("1 minute")
      const [first] = yield* settled(context.session.id, 1)
      expect(first).toMatchObject({ trigger: { type: "event", name: "tick" }, status: "completed" })
      yield* eventually(
        events
          .list(context.session.id)
          .pipe(Effect.map(([info]) => (info?.nextFireAt === at(120_000) ? info : undefined))),
      )

      yield* execute(context, 'return tools.event.disable({ name: "tick" })')
      expect((yield* events.list(context.session.id))[0]).toMatchObject({ enabled: false, runCount: 1 })
      expect((yield* events.list(context.session.id))[0]?.nextFireAt).toBeUndefined()
      yield* TestClock.adjust("5 minutes")
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 100)))
      expect(yield* invocations(context.session.id)).toHaveLength(1)

      yield* execute(context, 'return tools.event.enable({ name: "tick" })')
      // The interval keeps its cadence from the last firing without catching up on missed ones.
      yield* eventually(
        events
          .list(context.session.id)
          .pipe(Effect.map(([info]) => (info?.nextFireAt === at(420_000) ? info : undefined))),
      )
      yield* TestClock.adjust("1 minute")
      yield* settled(context.session.id, 2)
      expect((yield* events.list(context.session.id))[0]).toMatchObject({ enabled: true, runCount: 2 })
    }),
  )

  it.effect("resumes schedules after a restart without replaying missed firings", () =>
    Effect.gen(function* () {
      const context = yield* setup
      const start = yield* warm(context)
      const events = yield* CodeModeEvent.Service
      yield* execute(
        context,
        [
          "function tick(input) { return 1 }",
          'tools.event.define({ name: "every", schedule: { every: "10m" }, handler: "tick" })',
          `tools.event.define({ name: "later", schedule: { at: "${new Date(start + 3_600_000).toISOString()}" }, handler: "tick" })`,
        ].join("\n"),
      )
      // The host is down for 25 minutes: nothing fires, and nothing is replayed at startup.
      yield* TestClock.adjust("25 minutes")
      const scope = yield* Scope.make()
      yield* Layer.buildWithScope(CodeModeScheduler.layer, scope)
      yield* eventually(
        events
          .list(context.session.id)
          .pipe(
            Effect.map((list) =>
              list.find((info) => info.name === "every")?.nextFireAt === new Date(start + 30 * 60_000).toISOString()
                ? list
                : undefined,
            ),
          ),
      )
      expect(yield* invocations(context.session.id)).toEqual([])
      yield* TestClock.adjust("5 minutes")
      yield* settled(context.session.id, 1)
      yield* Scope.close(scope, Exit.void)

      // A one-time event whose time passed while the host was down fires once at startup.
      yield* TestClock.adjust("1 hour")
      const restarted = yield* Scope.make()
      yield* Layer.buildWithScope(CodeModeScheduler.layer, restarted)
      yield* settled(context.session.id, 2)
      expect((yield* invocations(context.session.id)).map((item) => item.trigger.name)).toEqual(["every", "later"])
      const later = (yield* events.list(context.session.id)).find((info) => info.name === "later")
      expect(later).toMatchObject({ runCount: 1, lastStatus: "completed" })
      expect(later?.nextFireAt).toBeUndefined()
      yield* Scope.close(restarted, Exit.void)
    }),
  )
})

describe("CodeModeEvent.next", () => {
  test("keeps an interval's cadence without catching up", () => {
    expect(CodeModeEvent.next({ every: "5m" }, { now: 0, anchor: 0 })).toBe(300_000)
    expect(CodeModeEvent.next({ every: "5m" }, { now: 300_000, anchor: 0, fired: 300_000 })).toBe(600_000)
    expect(CodeModeEvent.next({ every: "5m" }, { now: 1_000_000, anchor: 0, fired: 300_000 })).toBe(1_200_000)
  })

  test("follows cron expressions", () => {
    const monday = Date.parse("2026-09-28T08:59:30")
    expect(CodeModeEvent.next({ cron: "0 9 * * 1-5" }, { now: monday, anchor: 0 })).toBe(
      Date.parse("2026-09-28T09:00:00"),
    )
    expect(CodeModeEvent.next({ cron: "0 9 * * 1-5" }, { now: Date.parse("2026-09-28T09:00:00"), anchor: 0 })).toBe(
      Date.parse("2026-09-29T09:00:00"),
    )
  })

  test("fires a one-time event once, immediately when its time passed", () => {
    const at = "2026-09-28T09:00:00.000Z"
    expect(CodeModeEvent.next({ at }, { now: 0, anchor: 0 })).toBe(Date.parse(at))
    expect(CodeModeEvent.next({ at }, { now: Date.parse(at) + 5000, anchor: 0 })).toBe(Date.parse(at) + 5000)
    expect(CodeModeEvent.next({ at }, { now: 0, anchor: 0, fired: 1 })).toBeUndefined()
  })

  test("validates schedules", () => {
    expect(CodeModeEvent.scheduleProblem({ every: "30s" })).toBeUndefined()
    expect(CodeModeEvent.scheduleProblem({ every: "10ms" })).toBe("An event may fire at most once per second.")
    expect(CodeModeEvent.scheduleProblem({ every: "soon" })).toContain("must be a number and a unit")
    expect(CodeModeEvent.scheduleProblem({ cron: "not a cron" })).toContain("Invalid cron expression")
    expect(CodeModeEvent.scheduleProblem({ at: "tomorrow" })).toContain("must be an ISO 8601 date")
  })
})
