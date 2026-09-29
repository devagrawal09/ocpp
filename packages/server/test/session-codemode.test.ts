import { expect } from "bun:test"
import { Agent } from "@ocpp/core/agent"
import { Bus } from "@ocpp/core/bus"
import { Job } from "@ocpp/core/job"
import { Location } from "@ocpp/core/location"
import { LocationServiceMap } from "@ocpp/core/location-services"
import { Model } from "@ocpp/core/model"
import { PluginSupervisor } from "@ocpp/core/plugin/supervisor-service"
import { Provider } from "@ocpp/core/provider"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { SessionEvent } from "@ocpp/core/session/event"
import { SessionExecution } from "@ocpp/core/session/execution"
import { SessionMessage } from "@ocpp/core/session/message"
import { Tool } from "@ocpp/core/tool"
import { CodeModeExecution } from "@ocpp/schema/codemode-execution"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("lists a session's commands and events", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test-version" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const request = (path: string, init?: RequestInit) =>
      Effect.promise(() => handler(new Request(`http://ocpp.local${path}`, init)))
    const created = yield* request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).pipe(Effect.flatMap((response) => Effect.promise(() => response.json())))

    const commands = yield* request(`/api/session/${created.data.id}/command`)
    expect(commands.status).toBe(200)
    expect(yield* Effect.promise(() => commands.json())).toEqual({ data: [] })
    const events = yield* request(`/api/session/${created.data.id}/event`)
    expect(events.status).toBe(200)
    expect(yield* Effect.promise(() => events.json())).toEqual({ data: [] })
    expect((yield* request("/api/session/ses_missing/command")).status).toBe(404)
    expect((yield* request("/api/session/ses_missing/event")).status).toBe(404)
  }),
)

it.live("runs a session command the agent defined through POST /command", () =>
  Effect.gen(function* () {
    // The execution layer is the harness's handle on the server's own services: it runs the model's
    // program the way the runner does, and the command then runs over HTTP.
    const captured: { context?: Context.Context<Bus.Service | Job.Service | LocationServiceMap.Service> } = {}
    const execution = makeGlobalNode({
      service: SessionExecution.Service,
      layer: Layer.effect(
        SessionExecution.Service,
        Effect.gen(function* () {
          captured.context = yield* Effect.context<Bus.Service | Job.Service | LocationServiceMap.Service>()
          return SessionExecution.Service.of({
            active: Effect.succeed(new Set()),
            isActive: () => Effect.succeed(false),
            resume: () => Effect.void,
            wake: () => Effect.void,
            interrupt: () => Effect.succeed(false),
            awaitIdle: () => Effect.void,
          })
        }),
      ),
      deps: [Bus.node, Job.node, LocationServiceMap.node],
    })
    const handler = yield* ServerFetch.make(
      { app: { version: "test-version" }, database: { path: ":memory:" }, fs: { filewatcher: false } },
      { overrides: [[SessionExecution.node, execution]] },
    )
    const directory = yield* tmpdirScoped()
    const request = (path: string, body?: unknown) =>
      Effect.promise(() =>
        handler(
          new Request(`http://ocpp.local${path}`, {
            method: body === undefined ? "GET" : "POST",
            ...(body === undefined
              ? {}
              : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
          }),
        ),
      )
    const created = yield* request("/api/session", { location: { directory: directory.path } }).pipe(
      Effect.flatMap((response) => Effect.promise(() => response.json())),
    )
    const sessionID = Session.ID.make(created.data.id)
    const location = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
    const context = captured.context ?? (yield* Effect.die(new Error("The execution layer was not built")))
    yield* define(sessionID, location).pipe(Effect.provide(context))

    const listed = yield* request(`/api/session/${sessionID}/command`)
    expect(yield* Effect.promise(() => listed.json())).toEqual({
      data: [{ name: "triage", description: "", handler: "triage" }],
    })
    const rejected = yield* request(`/api/session/${sessionID}/command`, {
      command: "triage",
      text: "login fails",
      files: [{ uri: "file:///tmp/log.txt" }],
    })
    expect(rejected.status).toBe(400)
    expect(yield* Effect.promise(() => rejected.json())).toMatchObject({
      message: "/triage runs the notebook function triage with text only, so it does not accept files.",
      field: "files",
    })
    const ran = yield* request(`/api/session/${sessionID}/command`, { command: "triage", text: "login fails" })
    expect(ran.status).toBe(204)
    const invocation = yield* eventually(
      request(`/api/session/${sessionID}/message?order=asc`).pipe(
        Effect.flatMap((response) => Effect.promise(() => response.json())),
        Effect.map((page: { data: ReadonlyArray<SessionMessage.Info> }) =>
          page.data.find((message) => message.type === "invocation" && message.status === "completed"),
        ),
      ),
    )
    expect(invocation).toMatchObject({
      type: "invocation",
      trigger: { type: "command", name: "triage", text: "login fails" },
      code: 'return triage({"text":"login fails","command":"triage"})',
    })
    expect(JSON.stringify(invocation)).toContain("triaged login fails")
  }),
)

/** Runs the program that defines `/triage`, the way the runner runs a model's `execute` call. */
const define = Effect.fnUntraced(function* (sessionID: Session.ID, location: Location.Ref) {
  const bus = yield* Bus.Service
  const jobs = yield* Job.Service
  const locations = yield* LocationServiceMap.Service
  const assistantMessageID = SessionMessage.ID.create()
  const id = "call_" + assistantMessageID
  const code = [
    'function triage(input) { return "triaged " + input.text }',
    'tools.command.define({ name: "triage", handler: "triage" })',
  ].join("\n")
  yield* bus.publish(SessionEvent.Step.Started, {
    sessionID,
    assistantMessageID,
    agent: Agent.ID.make("build"),
    model: { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") },
  })
  yield* bus.publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID, id, name: "execute" })
  yield* bus.publish(SessionEvent.Tool.Called, { sessionID, assistantMessageID, id, input: { code }, executed: false })
  const result = yield* Effect.gen(function* () {
    const plugins = yield* PluginSupervisor.Service
    yield* plugins.flush
    const agents = yield* Agent.Service
    const registry = yield* Tool.Service
    const agent = yield* agents.select()
    const snapshot = yield* registry.snapshot(undefined, sessionID)
    return yield* snapshot.execute({
      sessionID,
      agent: agent.id,
      messageID: assistantMessageID,
      call: { type: "tool-call", id, name: "execute", input: { code } },
    })
  }).pipe(Effect.provide(locations.get(location)))
  yield* bus.publish(SessionEvent.Tool.Success, {
    sessionID,
    assistantMessageID,
    id,
    content: [{ type: "text", text: "started" }],
    executed: false,
  })
  const settled = yield* jobs.wait({ id: decodeStarted(result.output).executionID })
  expect(settled.info?.status).toBe("completed")
})

const decodeStarted = Schema.decodeUnknownSync(Schema.Struct({ executionID: CodeModeExecution.ID }))

/** Polls until `check` returns a value; the command's run settles in the background. */
const eventually = <A, E, R>(check: Effect.Effect<A | undefined, E, R>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt++) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))
    }
    return yield* Effect.die(new Error("condition never held"))
  })
