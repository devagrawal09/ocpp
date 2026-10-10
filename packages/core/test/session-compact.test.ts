import { describe, expect } from "bun:test"
import { LLMClient, LLMEvent, LanguageModel, type LLMRequest } from "@ocpp/ai"
import { OpenAIChat } from "@ocpp/ai/protocols"
import { Config } from "@ocpp/core/config"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Bus } from "@ocpp/core/bus"
import { Location } from "@ocpp/core/location"
import { LocationServiceMap } from "@ocpp/core/location-service-map"
import type { LocationServices } from "@ocpp/core/location-services"
import { Project } from "@ocpp/core/project"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { SessionCompaction } from "@ocpp/core/session/compaction"
import { SessionEvent } from "@ocpp/core/session/event"
import { SessionMessage } from "@ocpp/core/session/message"
import { SessionProjector } from "@ocpp/core/session/projector"
import { SessionRunnerModel } from "@ocpp/core/session/runner/model"
import { SessionStore } from "@ocpp/core/session/store"
import { Effect, Layer, LayerMap, Stream } from "effect"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { TestStepHost } from "./fixture/step-host"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const model = LanguageModel.make({
  id: "summary-model",
  provider: "test",
  route: OpenAIChat.route,
})
let requests: LLMRequest[] = []
const client = Layer.mock(LLMClient.Service)({
  stream: (request: LLMRequest) => {
    requests.push(request)
    return Stream.make(LLMEvent.textDelta({ id: "summary", text: "manual session summary" }))
  },
  generate: () => Effect.die("unused"),
})
const config = Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })
const models = Layer.mock(SessionRunnerModel.Service)({
  resolve: () =>
    Effect.succeed(
      SessionRunnerModel.resolved(model, {
        capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
        cost: [],
        limit: { context: 10_000, output: 1_000 },
      }),
    ),
})
const locations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    () =>
      // The test only needs the compaction location service used by Session.compact.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      SessionCompaction.layer.pipe(
        Layer.provide(client),
        Layer.provide(config),
        Layer.provide(models),
      ) as unknown as Layer.Layer<LocationServices>,
  ),
)

const steps = TestStepHost.make()
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [[LocationServiceMap.node, locations], [Project.node, globalProjectNode], steps.replacement],
  ),
)

describe("Session.compact", () => {
  it.effect("durably coalesces manual compaction", () =>
    Effect.gen(function* () {
      requests = []
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ location })

      const messageID = SessionMessage.ID.create()
      // A delivered prompt, in one commit so it never waits in the inbox.
      yield* bus.publishAll([
        [
          SessionEvent.InboxEnqueued,
          {
            sessionID: created.id,
            inboxID: messageID,
            item: {
              type: "user",
              payload: { text: "Please compact this session history." },
              delivery: "steer",
            },
          },
        ],
        [SessionEvent.InboxDelivered, { sessionID: created.id, inboxID: messageID }],
      ])

      expect(yield* session.compact({ id: messageID, sessionID: created.id }).pipe(Effect.flip)).toMatchObject({
        _tag: "Session.CompactionConflictError",
        inputID: messageID,
      })
      // A step in flight keeps the compaction pending until its boundary.
      const busy = yield* steps.busy(created.id)
      const first = yield* session.compact({ sessionID: created.id })
      const second = yield* session.compact({ sessionID: created.id })

      expect(second.id).toBe(first.id)
      expect(requests).toHaveLength(0)
      expect(yield* session.inbox(created.id)).toEqual([
        expect.objectContaining({ id: first.id, type: "compaction", delivery: "steer" }),
      ])
      expect((yield* session.context(created.id)).find((message) => message.id === first.id)).toBeUndefined()

      const queued = yield* session.create({ location })
      const queue = yield* session.compact({ sessionID: queued.id, delivery: "queue" })
      expect(queue).toMatchObject({ type: "compaction", delivery: "queue" })
      yield* busy.release
    }),
  )

  it.effect("coalesces concurrent manual compaction", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const created = yield* session.create({ location })
      const busy = yield* steps.busy(created.id)
      const admitted = yield* Effect.all(
        [SessionMessage.ID.create(), SessionMessage.ID.create()].map((id) =>
          session.compact({ id, sessionID: created.id }),
        ),
        { concurrency: "unbounded" },
      )

      expect(admitted[1]?.id).toBe(admitted[0]?.id)
      expect(yield* session.inbox(created.id)).toHaveLength(1)
      yield* busy.release
    }),
  )

  it.effect("commits a staged revert before admitting manual compaction", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const bus = yield* Bus.Service
      const created = yield* session.create({ location })
      const messageID = SessionMessage.ID.create()

      yield* bus.publishAll([
        [
          SessionEvent.InboxEnqueued,
          {
            sessionID: created.id,
            inboxID: messageID,
            item: {
              type: "user",
              payload: { text: "Undo this prompt before compacting." },
              delivery: "steer",
            },
          },
        ],
        [SessionEvent.InboxDelivered, { sessionID: created.id, inboxID: messageID }],
      ])
      yield* bus.publish(SessionEvent.RevertEvent.Staged, {
        sessionID: created.id,
        revert: { messageID, files: [] },
      })

      expect((yield* session.get(created.id)).revert?.messageID).toBe(messageID)

      const compacted = yield* session.compact({ sessionID: created.id })

      expect((yield* session.get(created.id)).revert).toBeUndefined()
      expect(compacted).toMatchObject({ type: "compaction" })
      // The runtime delivers the compaction to a history that no longer holds the reverted prompt.
      yield* session.wait(created.id)
      expect(steps.compactions).toContainEqual({ sessionID: created.id, reason: "manual", inputID: compacted.id })
      expect((yield* session.context(created.id)).some((message) => message.id === messageID)).toBe(false)
      expect(yield* session.inbox(created.id)).toEqual([])
    }),
  )
})
