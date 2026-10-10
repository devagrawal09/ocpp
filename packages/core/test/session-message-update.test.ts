import { describe, expect } from "bun:test"
import { Effect, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Agent } from "@ocpp/core/agent"
import { Bus } from "@ocpp/core/bus"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { EventTable } from "@ocpp/core/event/sql"
import { Location } from "@ocpp/core/location"
import { Model } from "@ocpp/core/model"
import { Project } from "@ocpp/core/project"
import { Provider } from "@ocpp/core/provider"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { SessionEvent } from "@ocpp/core/session/event"
import { SessionMessage } from "@ocpp/core/session/message"
import { SessionProjector } from "@ocpp/core/session/projector"
import { SessionTable } from "@ocpp/core/session/sql"
import { SessionStore } from "@ocpp/core/session/store"
import { Money } from "@ocpp/schema/money"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { testEffect } from "./lib/effect"
import { Recorded } from "./lib/recorded"
import { globalProjectNode } from "./lib/project"
import { TestStepHost } from "./fixture/step-host"

const steps = TestStepHost.make()
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [[Bus.node, Bus.configured()], [Project.node, globalProjectNode], steps.replacement],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const model = { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }

const start = (bus: Bus.Interface, sessionID: Session.ID, messageID: SessionMessage.ID) =>
  bus.publish(SessionEvent.Step.Started, {
    sessionID,
    assistantMessageID: messageID,
    agent: Agent.defaultID,
    model,
  })

const complete = (bus: Bus.Interface, sessionID: Session.ID, messageID: SessionMessage.ID) =>
  bus.publish(SessionEvent.Step.Ended, {
    sessionID,
    assistantMessageID: messageID,
    finish: "stop",
    cost: Money.USD.make(0),
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })

describe("Session.updateMessage", () => {
  it.effect("replaces assistant content through a durable projected event", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const db = (yield* Database.Service).db
      const created = yield* session.create({ location })
      const messageID = SessionMessage.ID.create()
      yield* start(bus, created.id, messageID)
      yield* complete(bus, created.id, messageID)

      const content = [
        SessionMessage.AssistantText.make({ type: "text", text: "replacement" }),
        SessionMessage.AssistantReasoning.make({
          type: "reasoning",
          text: "updated reasoning",
          time: { created: created.time.created },
        }),
      ]
      const updated = yield* session.updateMessage({ sessionID: created.id, messageID, content })

      expect(updated.content).toEqual(content)
      expect(yield* session.message({ sessionID: created.id, messageID })).toMatchObject({ content })
      expect((yield* session.messages({ sessionID: created.id }))[0]).toMatchObject({ id: messageID, content })

      const events = Array.from(yield* Stream.runCollect(session.log({ sessionID: created.id })))
      expect(events.at(-2)).toMatchObject({
        type: "session.message.content.updated",
        data: {
          sessionID: created.id,
          messageID,
          content: [
            { type: "text", text: "replacement" },
            { type: "reasoning", text: "updated reasoning", time: { created: expect.any(Number) } },
          ],
        },
      })
      expect(
        (yield* Recorded.events(eq(EventTable.type, Bus.versionedType(SessionEvent.MessageContentUpdated.type, 1)))).at(
          0,
        ),
      ).toMatchObject({ aggregate_id: created.id, data: { messageID } })

      expect((yield* session.updateMessage({ sessionID: created.id, messageID, content: [] })).content).toEqual([])
    }),
  )

  it.effect("rebuilds updated assistant content into a fresh projection", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const store = yield* SessionStore.Service
      const db = (yield* Database.Service).db
      const created = yield* session.create({ location })
      const messageID = SessionMessage.ID.create()
      yield* start(bus, created.id, messageID)
      yield* complete(bus, created.id, messageID)
      const content = [
        SessionMessage.AssistantReasoning.make({
          type: "reasoning",
          text: "replayed reasoning",
          time: { created: created.time.created },
        }),
      ]
      yield* session.updateMessage({ sessionID: created.id, messageID, content })

      yield* db.delete(SessionTable).where(eq(SessionTable.id, created.id)).run().pipe(Effect.orDie)
      expect(yield* store.message(messageID)).toBeUndefined()
      yield* bus.rebuild(created.id)
      expect((yield* store.message(messageID))?.message).toMatchObject({ content })
    }),
  )

  it.effect("rejects missing and cross-session messages", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ location })
      const other = yield* session.create({ location })
      const messageID = SessionMessage.ID.create()
      yield* start(bus, created.id, messageID)
      yield* complete(bus, created.id, messageID)

      expect(yield* Effect.flip(session.updateMessage({ sessionID: other.id, messageID, content: [] }))).toEqual(
        new Session.MessageNotFoundError({ sessionID: other.id, messageID }),
      )
      const missing = Session.ID.create()
      expect(yield* Effect.flip(session.updateMessage({ sessionID: missing, messageID, content: [] }))).toEqual(
        new Session.NotFoundError({ sessionID: missing }),
      )
    }),
  )

  it.effect("rejects non-assistant messages, incomplete assistants, and unfinished tools", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ location })
      const synthetic = yield* bus.publish(SessionEvent.Synthetic, { sessionID: created.id, text: "synthetic" })
      const syntheticID = SessionMessage.ID.fromEvent(synthetic.id)

      expect(
        yield* Effect.flip(session.updateMessage({ sessionID: created.id, messageID: syntheticID, content: [] })),
      ).toEqual(new Session.MessageNotAssistantError({ sessionID: created.id, messageID: syntheticID }))

      const messageID = SessionMessage.ID.create()
      yield* start(bus, created.id, messageID)
      expect(yield* Effect.flip(session.updateMessage({ sessionID: created.id, messageID, content: [] }))).toEqual(
        new Session.MessageIncompleteError({ sessionID: created.id, messageID }),
      )

      yield* complete(bus, created.id, messageID)
      yield* Effect.forEach(
        [
          SessionMessage.ToolStateStreaming.make({ status: "streaming", input: "" }),
          SessionMessage.ToolStateRunning.make({ status: "running", input: {}, metadata: {} }),
        ],
        Effect.fnUntraced(function* (state) {
          const unfinished = SessionMessage.AssistantTool.make({
            type: "tool",
            id: "call_unfinished",
            name: "read",
            state,
            time: { created: created.time.created },
          })
          expect(
            yield* Effect.flip(session.updateMessage({ sessionID: created.id, messageID, content: [unfinished] })),
          ).toEqual(new Session.MessageToolIncompleteError({ sessionID: created.id, messageID }))
        }),
      )
    }),
  )

  it.effect("accepts completed and failed tool content", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ location })
      const messageID = SessionMessage.ID.create()
      yield* start(bus, created.id, messageID)
      yield* complete(bus, created.id, messageID)
      const content = [
        SessionMessage.ToolStateCompleted.make({
          status: "completed",
          input: {},
          content: [{ type: "text", text: "result" }],
        }),
        SessionMessage.ToolStateError.make({ status: "error", input: {}, error: { type: "tool", message: "failed" } }),
      ].map((state) =>
        SessionMessage.AssistantTool.make({
          type: "tool",
          id: `call_${state.status}`,
          name: "read",
          state,
          time: { created: created.time.created },
        }),
      )

      expect((yield* session.updateMessage({ sessionID: created.id, messageID, content })).content).toEqual(content)
    }),
  )

  it.effect("rejects a completed assistant while its session is active", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ location })
      const messageID = SessionMessage.ID.create()
      yield* start(bus, created.id, messageID)
      yield* complete(bus, created.id, messageID)
      const busy = yield* steps.busy(created.id)
      const failure = yield* Effect.flip(session.updateMessage({ sessionID: created.id, messageID, content: [] }))
      yield* busy.release

      expect(failure).toEqual(new Session.BusyError({ sessionID: created.id }))
    }),
  )
})
