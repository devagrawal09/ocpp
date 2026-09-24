import { describe, expect } from "bun:test"
import { LanguageModel, LLMClient, LLMEvent } from "@ocpp/ai"
import { OpenAIChat } from "@ocpp/ai/protocols"
import { Bus } from "@ocpp/core/bus"
import { Config } from "@ocpp/core/config"
import { ConfigCompactionPlugin } from "@ocpp/core/config/plugin/compaction"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { llmClient } from "@ocpp/core/effect/app-node-platform"
import { SessionCompaction } from "@ocpp/core/session/compaction"
import { SessionEvent } from "@ocpp/core/session/event"
import { SessionMessage } from "@ocpp/core/session/message"
import { SessionModelRequest } from "@ocpp/core/session/model-request"
import { SessionRunnerModel } from "@ocpp/core/session/runner/model"
import { Session } from "@ocpp/core/session"
import { Agent } from "@ocpp/core/agent"
import { Location } from "@ocpp/core/location"
import { Project } from "@ocpp/core/project"
import { AbsolutePath } from "@ocpp/core/schema"
import { ConfigCompaction } from "@ocpp/schema/config/compaction"
import { Document, Event, Info } from "@ocpp/schema/config"
import { Money } from "@ocpp/schema/money"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { DateTime, Effect, Fiber, Layer, Option, Schema, Stream } from "effect"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const model = LanguageModel.make({
  id: "test-model",
  provider: "test-provider",
  route: OpenAIChat.route,
})
const limit = { context: 100_000, output: 1_000 }
const resolved = SessionRunnerModel.resolved(model, {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit,
})
const config = Config.testLayer()
const it = testEffect(
  Layer.merge(
    config,
    AppNodeBuilder.build(LayerNode.group([SessionCompaction.node, SessionModelRequest.node, Config.node, Bus.node]), [
      [
        llmClient,
        Layer.mock(LLMClient.Service)({
          stream: () => Stream.make(LLMEvent.textDelta({ id: "summary", text: "summary" })),
        }),
      ],
      [Config.node, config],
    ]),
  ),
)
describe("ConfigCompactionPlugin.Plugin", () => {
  it.live("merges settings and reloads changed config", () =>
    Effect.gen(function* () {
      const compaction = yield* SessionCompaction.Service
      const modelRequests = yield* SessionModelRequest.Service
      const config = yield* Config.Test
      const bus = yield* Bus.Service
      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ auto: false, buffer: 20_000 }) }),
        }),
        new Document({
          type: "document",
          info: new Info({
            compaction: new ConfigCompaction.Info({
              buffer: 10_000,
              keep: new ConfigCompaction.Keep({ tokens: 0 }),
            }),
          }),
        }),
      ])
      yield* ConfigCompactionPlugin.Plugin.effect(host({ event: { subscribe: () => bus.subscribe(Event.Updated) } }))

      expect(compaction.required(nearInput)).toBe(false)
      const started = yield* bus
        .subscribe(SessionEvent.Compaction.Started)
        .pipe(Stream.runHead, Effect.forkScoped({ startImmediately: true }))
      expect(
        yield* compaction.compactManual({
          session,
          resolveModel: () => Effect.succeed(resolved),
          prepare: modelRequests.prepare,
          messages: [
            {
              id: SessionMessage.ID.create(),
              type: "user",
              text: "Older context",
              time: { created: DateTime.makeUnsafe(0) },
            },
            {
              id: SessionMessage.ID.create(),
              type: "user",
              text: "Recent context",
              time: { created: DateTime.makeUnsafe(1) },
            },
          ],
          inputID: SessionMessage.ID.make("msg_compaction_manual"),
        }),
      ).toEqual({ status: "completed" })
      expect(Option.getOrThrow(yield* Fiber.join(started)).data.recent).toContain("Recent context")

      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ auto: true, buffer: 20_000 }) }),
        }),
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ buffer: 10_000 }) }),
        }),
      ])
      yield* bus.publish(Event.Updated, {})
      yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 200; attempt++) {
          if (compaction.required(nearInput)) return
          yield* Effect.sleep("10 millis")
        }
        yield* Effect.die(new Error("Timed out waiting for compaction config reload"))
      })
      expect(compaction.required(bufferedInput)).toBe(false)

      yield* config.setEntries([
        new Document({
          type: "document",
          info: new Info({ compaction: new ConfigCompaction.Info({ auto: true, buffer: 20_000 }) }),
        }),
      ])
      yield* bus.publish(Event.Updated, {})
      for (let attempt = 0; attempt < 200; attempt++) {
        if (compaction.required(bufferedInput)) return
        yield* Effect.sleep("10 millis")
      }
      yield* Effect.die(new Error("Timed out waiting for compaction config reload"))
    }),
  )
})

const session = Session.Info.make({
  id: Session.ID.make("ses_compaction_config"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/tmp") }),
})
const input = (tokens: number) => ({
  session,
  resolved,
  messages: [
    Schema.decodeUnknownSync(SessionMessage.Assistant)({
      id: SessionMessage.ID.make("msg_compaction_config"),
      type: "assistant",
      agent: Agent.defaultID,
      model: { id: "test-model", providerID: "test-provider" },
      content: [],
      tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, completed: 0 },
    }),
  ],
})
const bufferedInput = input(85_000)
const nearInput = input(95_000)
