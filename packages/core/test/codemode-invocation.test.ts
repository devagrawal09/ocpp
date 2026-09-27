import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Agent } from "@ocpp/core/agent"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Database } from "@ocpp/core/database/database"
import { Bus } from "@ocpp/core/bus"
import { CodeModeCommand } from "@ocpp/core/codemode/command"
import { CodeModeEvent } from "@ocpp/core/codemode/event"
import { CodeModeInvocation } from "@ocpp/core/codemode/invocation"
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

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
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
    ]),
    [
      [Project.node, globalProjectNode],
      [SessionExecution.node, execution],
      [SessionModelTransport.node, transport],
    ],
  ),
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

/** Polls until `check` returns a value, since completions are delivered from background fibers. */
const eventually = <A, E, R>(check: Effect.Effect<A | undefined, E, R>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die(new Error("condition never held"))
  })

const invocations = (sessionID: Session.ID) =>
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const messages = yield* sessions.messages({ sessionID, order: "asc" })
    return messages.filter((message): message is SessionMessage.Invocation => message.type === "invocation")
  })

describe("Code Mode commands", () => {
  it.live("runs a command's handler with the prompt text without waking the model", () =>
    Effect.gen(function* () {
      const context = yield* setup
      const session = context.session
      const sessions = yield* Session.Service
      const jobs = yield* Job.Service
      const defined = yield* execute(
        context,
        [
          'function triage(input) { return "triaged " + input.command + ": " + input.text }',
          'return tools.command.define({ name: "triage", description: "Triage a bug", handler: "triage" })',
        ].join("\n"),
      )
      expect(defined?.status).toBe("completed")
      const commands = yield* CodeModeCommand.Service
      expect(yield* commands.list(session.id)).toEqual([
        { name: "triage", description: "Triage a bug", handler: "triage" },
      ])

      wakes.length = 0
      yield* sessions.command({ sessionID: session.id, command: "triage", text: "login fails" })
      const invocation = (yield* invocations(session.id))[0]!
      expect(invocation).toMatchObject({
        trigger: { type: "command", name: "triage", text: "login fails" },
        code: 'return triage({"text":"login fails","command":"triage"})',
      })
      yield* jobs.wait({ id: invocation.executionID })
      const completed = yield* eventually(
        invocations(session.id).pipe(Effect.map((list) => list.find((item) => item.status !== "running"))),
      )
      expect(completed.status).toBe("completed")
      expect(completed.events).toContainEqual({ type: "trace", kind: "return", value: "triaged triage: login fails" })
      const outcome = yield* notification(session.id, invocation.executionID)
      expect(outcome.text).toContain('The user ran the command /triage with the text "login fails".')
      expect(outcome.text).toContain("triaged triage: login fails")
      expect(wakes).toEqual([])
    }),
  )
})
