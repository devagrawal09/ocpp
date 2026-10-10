import { expect } from "bun:test"
import { Agent } from "@ocpp/core/agent"
import { Bus } from "@ocpp/core/bus"
import { Model } from "@ocpp/core/model"
import { Provider } from "@ocpp/core/provider"
import { Session } from "@ocpp/core/session"
import { SessionEvent } from "@ocpp/core/session/event"
import { Job } from "@ocpp/core/job"
import { LocationServiceMap } from "@ocpp/core/location-services"
import { SessionMessage } from "@ocpp/core/session/message"
import { type Context, Effect } from "effect"
import { TestStepHost } from "../../core/test/fixture/step-host"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("updates completed assistant message content through the session HTTP API", () =>
  Effect.gen(function* () {
    const state = { user: SessionMessage.ID.create() }
    // The runtime runs the Session; the test step host plays its steps without a model.
    const captured: { current?: Context.Context<Bus.Service | Job.Service | LocationServiceMap.Service> } = {}
    const steps = TestStepHost.make({ capture: captured })
    const handler = yield* ServerFetch.make(
      { app: { version: "test-version" }, database: { path: ":memory:" }, fs: { filewatcher: false } },
      { overrides: [steps.replacement] },
    )
    const created = yield* Effect.promise(() =>
      handler(
        new Request("http://ocpp.local/api/session", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        }),
      ).then((response) => response.json()),
    )
    const sessionID = Session.ID.make(created.data.id)
    const prompt = () =>
      Effect.promise(() =>
        handler(
          new Request(`http://ocpp.local/api/session/${sessionID}/prompt`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: state.user, text: "prompt" }),
          }),
        ),
      )
    const wait = () =>
      Effect.promise(() => handler(new Request(`http://ocpp.local/api/session/${sessionID}/wait`, { method: "POST" })))
    /** The Session's latest assistant message: the step that answered the prompt. */
    const answer = () =>
      Effect.promise(() =>
        handler(new Request(`http://ocpp.local/api/session/${sessionID}/message?order=asc`)).then((response) =>
          response.json(),
        ),
      ).pipe(
        Effect.map(
          (page: { data: ReadonlyArray<SessionMessage.Info> }) =>
            page.data.filter((message) => message.type === "assistant").at(-1)?.id ??
            SessionMessage.ID.make("msg_missing"),
        ),
      )
    const update = (messageID: SessionMessage.ID, body: unknown, id = sessionID) =>
      Effect.promise(() =>
        handler(
          new Request(`http://ocpp.local/api/session/${id}/message/${messageID}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        ),
      )

    steps.script(sessionID, [{ finish: "stop" }])
    expect((yield* prompt()).status).toBe(200)
    expect((yield* wait()).status).toBe(204)
    const assistant = yield* answer()
    const content = [
      { type: "text", text: "edited assistant response" },
      { type: "reasoning", text: "edited reasoning", time: { created: 123 } },
    ]
    const updated = yield* update(assistant, { content })
    expect(updated.status).toBe(200)
    expect(yield* Effect.promise(() => updated.json())).toMatchObject({
      data: { id: assistant, type: "assistant", content },
    })

    const projected = yield* Effect.promise(() =>
      handler(new Request(`http://ocpp.local/api/session/${sessionID}/message/${assistant}`)).then((response) =>
        response.json(),
      ),
    )
    expect(projected.data.content).toEqual(content)
    expect((yield* update(assistant, { text: "not a content array" })).status).toBe(400)
    const unfinished = yield* update(assistant, {
      content: [
        {
          type: "tool",
          id: "call_unfinished",
          name: "read",
          state: { status: "streaming", input: "" },
          time: { created: 123 },
        },
      ],
    })
    expect(unfinished.status).toBe(400)
    expect(yield* Effect.promise(() => unfinished.json())).toMatchObject({
      _tag: "InvalidRequestError",
      field: "content",
    })
    const nonAssistant = yield* update(state.user, { content: [] })
    expect(nonAssistant.status).toBe(400)
    expect(yield* Effect.promise(() => nonAssistant.json())).toMatchObject({ _tag: "InvalidRequestError" })
    expect((yield* update(SessionMessage.ID.create(), { content: [] })).status).toBe(404)
    expect((yield* update(assistant, { content: [] }, Session.ID.create())).status).toBe(404)

    // While a step is in flight the Session is busy.
    const held = steps.hold(sessionID)
    state.user = SessionMessage.ID.create()
    expect((yield* prompt()).status).toBe(200)
    yield* held.started
    const busy = yield* update(assistant, { content: [] })
    expect(busy.status).toBe(409)
    expect(yield* Effect.promise(() => busy.json())).toMatchObject({ _tag: "SessionBusyError", sessionID })
    yield* held.release
    expect((yield* wait()).status).toBe(204)

    // An assistant message a step left incomplete (as a stopped process leaves it) cannot be edited.
    const context = captured.current ?? (yield* Effect.die(new Error("The step host was not built")))
    const incompleteID = SessionMessage.ID.create()
    yield* Bus.Service.use((bus) =>
      bus.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID: incompleteID,
        agent: Agent.defaultID,
        model: { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") },
      }),
    ).pipe(Effect.provide(context))
    const incomplete = yield* update(incompleteID, { content: [] })
    expect(incomplete.status).toBe(409)
    expect(yield* Effect.promise(() => incomplete.json())).toMatchObject({
      _tag: "ConflictError",
      resource: incompleteID,
    })
  }),
)
