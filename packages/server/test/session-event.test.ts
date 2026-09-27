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

type Services = Bus.Service | Job.Service | LocationServiceMap.Service

it.live("controls a session's events from the app without the agent's permission rules", () =>
  Effect.gen(function* () {
    // The agent may not trigger this event, but the user can from the app.
    const server = yield* serve({ permission: { event_trigger: "deny", event_enable: "deny" } })
    yield* server.run(
      [
        'function poll(input) { return "polled " + input.event }',
        'tools.event.define({ name: "poll", schedule: { every: "1h" }, handler: "poll" })',
      ].join("\n"),
    )
    const listed = yield* server.json(`/event`)
    expect(listed.data).toMatchObject([{ name: "poll", enabled: true, runCount: 0 }])
    expect(listed.data[0].nextFireAt).toBeString()

    const disabled = yield* server.request(`/event/poll/disable`, { method: "POST" })
    expect(disabled.status).toBe(200)
    const off = yield* Effect.promise(() => disabled.json())
    expect(off.data).toMatchObject({ name: "poll", enabled: false })
    expect(off.data.nextFireAt).toBeUndefined()
    const enabled = yield* server.request(`/event/poll/enable`, { method: "POST" })
    expect(enabled.status).toBe(200)
    expect((yield* Effect.promise(() => enabled.json())).data).toMatchObject({ name: "poll", enabled: true })

    const triggered = yield* server.request(`/event/poll/trigger`, { method: "POST", body: {} })
    expect(triggered.status).toBe(200)
    const firing = (yield* Effect.promise(() => triggered.json())).data
    expect(firing).toMatchObject({ status: "started" })
    expect(firing.executionID).toStartWith("exe_")
    expect(firing.messageID).toStartWith("msg_")
    const event = yield* eventually(
      server
        .json(`/event`)
        .pipe(
          Effect.map((page: { data: ReadonlyArray<{ lastStatus?: string }> }) =>
            page.data[0]?.lastStatus === "completed" ? page.data[0] : undefined,
          ),
        ),
    )
    // The latest firing points at the invocation message the timeline shows for it.
    expect(event).toMatchObject({ runCount: 1, lastMessageID: firing.messageID, lastSummary: "polled poll" })
    expect((yield* server.json(`/message/${firing.messageID}`)).data).toMatchObject({
      type: "invocation",
      trigger: { type: "event", name: "poll" },
      executionID: firing.executionID,
    })

    const removed = yield* server.request(`/event/poll`, { method: "DELETE" })
    expect(removed.status).toBe(204)
    expect((yield* server.json(`/event`)).data).toEqual([])
  }),
)

it.live("answers 404 for an unknown event or session", () =>
  Effect.gen(function* () {
    const server = yield* serve()
    for (const [path, method] of [
      ["/event/missing/enable", "POST"],
      ["/event/missing/disable", "POST"],
      ["/event/missing/trigger", "POST"],
      ["/event/missing", "DELETE"],
    ] as const) {
      const response = yield* server.request(path, { method, ...(method === "POST" ? { body: {} } : {}) })
      expect(response.status).toBe(404)
      expect(yield* Effect.promise(() => response.json())).toMatchObject({
        _tag: "EventNotFoundError",
        event: "missing",
        message: "No event is named missing.",
      })
    }
    const unknown = yield* Effect.promise(() =>
      server.handler(new Request("http://ocpp.local/api/session/ses_missing/event/poll/enable", { method: "POST" })),
    )
    expect(unknown.status).toBe(404)
  }),
)

it.live("cancels only a running execution of the session", () =>
  Effect.gen(function* () {
    const server = yield* serve()
    const other = yield* server.create()
    const jobs = yield* Job.Service.pipe(Effect.provide(server.context))
    const start = (ownerSessionID: Session.ID) =>
      jobs.startLimited({
        id: CodeModeExecution.ID.create(),
        type: "codemode",
        ownerSessionID,
        maxConcurrent: 4,
        run: Effect.never,
      })
    const own = yield* start(server.sessionID)
    const foreign = yield* start(other)
    if (!own || !foreign) return yield* Effect.die(new Error("The executions did not start"))

    const cancel = (executionID: string) =>
      server
        .request(`/execution/${executionID}/cancel`, { method: "POST" })
        .pipe(Effect.flatMap((response) => Effect.promise(() => response.json())))
    expect(yield* cancel(foreign.id)).toEqual({ cancelled: false })
    expect((yield* jobs.get(foreign.id))?.status).toBe("running")
    expect(yield* cancel(own.id)).toEqual({ cancelled: true })
    expect((yield* jobs.get(own.id))?.status).toBe("cancelled")
    // A settled execution is not running any more.
    expect(yield* cancel(own.id)).toEqual({ cancelled: false })
    yield* jobs.cancel(foreign.id)
  }),
)

/**
 * Starts a server with one Session in a fresh directory. The execution layer is the harness's handle on
 * the server's own services: it runs the model's program the way the runner does.
 */
const serve = Effect.fnUntraced(function* (config?: unknown) {
  const captured: { context?: Context.Context<Services> } = {}
  const execution = makeGlobalNode({
    service: SessionExecution.Service,
    layer: Layer.effect(
      SessionExecution.Service,
      Effect.gen(function* () {
        captured.context = yield* Effect.context<Services>()
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
  if (config !== undefined)
    yield* Effect.promise(() => Bun.write(`${directory.path}/ocpp.json`, JSON.stringify(config)))
  const create = () =>
    Effect.promise(() =>
      handler(
        new Request("http://ocpp.local/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ location: { directory: directory.path } }),
        }),
      ).then((response) => response.json()),
    ).pipe(Effect.map((created) => Session.ID.make(created.data.id)))
  const sessionID = yield* create()
  const location = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
  const context = captured.context ?? (yield* Effect.die(new Error("The execution layer was not built")))
  const request = (path: string, init?: { method?: string; body?: unknown }) =>
    Effect.promise(() =>
      handler(
        new Request(`http://ocpp.local/api/session/${sessionID}${path}`, {
          method: init?.method ?? "GET",
          ...(init?.body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
        }),
      ),
    )
  return {
    handler,
    context,
    sessionID,
    create,
    request,
    json: (path: string) => request(path).pipe(Effect.flatMap((response) => Effect.promise(() => response.json()))),
    run: (code: string) => run(sessionID, location, code).pipe(Effect.provide(context)),
  }
})

/** Runs a program the way the runner runs a model's `execute` call, and waits for it to settle. */
const run = Effect.fnUntraced(function* (sessionID: Session.ID, location: Location.Ref, code: string) {
  const bus = yield* Bus.Service
  const jobs = yield* Job.Service
  const locations = yield* LocationServiceMap.Service
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
  const result = yield* Effect.gen(function* () {
    const plugins = yield* PluginSupervisor.Service
    yield* plugins.flush
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

/** Polls until `check` returns a value; a firing settles in the background. */
const eventually = <A, E, R>(check: Effect.Effect<A | undefined, E, R>) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500; attempt++) {
      const value = yield* check
      if (value !== undefined) return value
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)))
    }
    return yield* Effect.die(new Error("condition never held"))
  })
