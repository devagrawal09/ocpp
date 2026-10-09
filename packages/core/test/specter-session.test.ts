import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { asc, eq } from "drizzle-orm"
import { LanguageModel } from "@ocpp/ai"
import { OpenAIChat } from "@ocpp/ai/protocols/openai-chat"
import { TestLLM } from "@ocpp/ai/testing"
import { hostModel } from "@specter/agent-runtime"
import { Bus } from "@ocpp/core/bus"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { LayerNodePlatform } from "@ocpp/core/effect/app-node-platform"
import { EventTable } from "@ocpp/core/event/sql"
import { LocationServiceMap } from "@ocpp/core/location-service-map"
import { Project } from "@ocpp/core/project"
import { ProjectTable } from "@ocpp/core/project/sql"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { SessionProjector } from "@ocpp/core/session/projector"
import { SessionTable } from "@ocpp/core/session/sql"
import { SessionStore } from "@ocpp/core/session/store"
import { SpecterSessions } from "@ocpp/core/specter/index"
import { SpecterSessionModel } from "@ocpp/core/specter/session-model"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { promptLocationNode } from "./fixture/prompt-location"
import { testEffect } from "./lib/effect"

// OC++'s Session facade with the switch on: the embedded Specter runtime runs the Session, and OC++
// sees its events on the Bus.
const languageModel = LanguageModel.make({ id: "fake-model", provider: "fake", route: OpenAIChat.route })
const fixedModel = makeGlobalNode({
  service: SpecterSessionModel.Service,
  layer: Layer.effect(
    SpecterSessionModel.Service,
    hostModel(() => Effect.succeed({ model: languageModel, ref: { id: "fake-model", providerID: "fake" } })),
  ),
  deps: [LayerNodePlatform.llmClient],
})

const layer = AppNodeBuilder.build(
  LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
  [
    [Bus.node, Bus.configured({ persist: true })],
    [LocationServiceMap.node, promptLocationNode],
    [SpecterSessionModel.node, fixedModel],
    [LayerNodePlatform.llmClient, TestLLM.clientLayer],
    ...SpecterSessions.replacements,
  ],
).pipe(Layer.provideMerge(TestLLM.layer({ fallback: [] })))
const it = testEffect(layer)

const sessionID = Session.ID.make("ses_specter_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const eventTypes = Database.Service.use(({ db }) =>
  db
    .select({ type: EventTable.type })
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map((row) => row.type.replace(/\.\d+$/, ""))),
    ),
)

describe("Sessions on the Specter runtime", () => {
  it.live("runs a prompt to a reply through OC++'s Session facade", () =>
    Effect.gen(function* () {
      yield* setup
      yield* TestLLM.push(TestLLM.text("Hello from Specter", "text_1"))
      const session = yield* Session.Service

      yield* session.prompt({ sessionID, text: "Hi" })
      yield* session.wait(sessionID)

      const messages = yield* session.messages({ sessionID, order: "asc" })
      expect(messages.map((message) => message.type)).toEqual(["user", "assistant"])
      const [user, assistant] = messages
      expect(user?.type === "user" ? user.text : undefined).toBe("Hi")
      expect(
        assistant?.type === "assistant"
          ? assistant.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
          : [],
      ).toEqual(["Hello from Specter"])
      expect(yield* session.inbox(sessionID)).toEqual([])
      expect(yield* session.active).toEqual(new Set())
      expect(yield* eventTypes).toEqual([
        "session.inbox.enqueued",
        "session.execution.started",
        "session.inbox.delivered",
        "session.step.started",
        "session.text.started",
        "session.text.ended",
        "session.step.ended",
        "session.execution.succeeded",
      ])
    }),
  )

  it.live("runs a Code Mode tool call and returns its result to the next step", () =>
    Effect.gen(function* () {
      yield* setup
      const llm = yield* TestLLM.Service
      yield* llm.push(
        TestLLM.tool("call_1", "execute", { code: "return 6 * 7" }),
        TestLLM.text("The answer is 42", "text_1"),
      )
      const session = yield* Session.Service

      yield* session.prompt({ sessionID, text: "Compute it" })
      yield* session.wait(sessionID)

      const messages = yield* session.messages({ sessionID, order: "asc" })
      expect(messages.map((message) => message.type)).toEqual(["user", "assistant", "assistant"])
      const tool =
        messages[1]?.type === "assistant" ? messages[1].content.find((part) => part.type === "tool") : undefined
      expect(tool?.type === "tool" ? tool.state.status : undefined).toBe("completed")
      expect(JSON.stringify(llm.requests[1]?.messages)).toContain("42")
      expect(yield* eventTypes).toEqual([
        "session.inbox.enqueued",
        "session.execution.started",
        "session.inbox.delivered",
        "session.step.started",
        "session.tool.input.started",
        "session.tool.input.ended",
        "session.tool.called",
        "session.tool.success",
        "session.step.ended",
        "session.step.started",
        "session.text.started",
        "session.text.ended",
        "session.step.ended",
        "session.execution.succeeded",
      ])
    }),
  )

  it.live("interrupts a running step and goes idle", () =>
    Effect.gen(function* () {
      yield* setup
      const llm = yield* TestLLM.Service
      const gate = yield* llm.gate
      yield* llm.push(TestLLM.text("Never seen", "text_1"))
      const session = yield* Session.Service

      yield* session.prompt({ sessionID, text: "Start" })
      yield* gate.started
      expect(yield* session.active).toEqual(new Set([sessionID]))
      expect(yield* session.interrupt(sessionID)).toBe(true)
      yield* session.wait(sessionID)
      yield* gate.release

      expect(yield* session.active).toEqual(new Set())
      expect(yield* session.interrupt(sessionID)).toBe(false)
      const types = yield* eventTypes
      expect(types.at(-1)).toBe("session.execution.interrupted")
      expect(types).not.toContain("session.text.started")
    }),
  )

  it.live("cancels a queued input while a step runs", () =>
    Effect.gen(function* () {
      yield* setup
      const llm = yield* TestLLM.Service
      const gate = yield* llm.gate
      yield* llm.push(TestLLM.text("First answer", "text_1"))
      const session = yield* Session.Service

      yield* session.prompt({ sessionID, text: "First" })
      yield* gate.started
      const queued = yield* session.prompt({ sessionID, text: "Later", delivery: "queue" })
      expect((yield* session.inbox(sessionID)).map((item) => item.id)).toEqual([queued.id])
      yield* session.cancelInbox({ sessionID, inboxID: queued.id })
      expect(yield* session.inbox(sessionID)).toEqual([])
      yield* gate.release
      yield* session.wait(sessionID)

      const messages = yield* session.messages({ sessionID, order: "asc" })
      expect(messages.map((message) => (message.type === "user" ? message.text : message.type))).toEqual([
        "First",
        "assistant",
      ])
      expect(yield* eventTypes).toContain("session.inbox.cancelled")
      expect(llm.requests).toHaveLength(1)
    }),
  )
})
