import { describe, expect } from "bun:test"
import { DateTime, Effect, Fiber, Option, Schema, Stream } from "effect"
import { asc, eq, sql } from "drizzle-orm"
import { Database } from "@ocpp/core/database/database"
import { Agent } from "@ocpp/core/agent"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { Bus } from "@ocpp/core/bus"
import { Event } from "@ocpp/schema/event"
import { EventTable } from "@ocpp/core/event/sql"
import { Model } from "@ocpp/core/model"
import { Project } from "@ocpp/core/project"
import { ProjectTable } from "@ocpp/core/project/sql"
import { Provider } from "@ocpp/core/provider"
import { AbsolutePath, RelativePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { SessionEvent } from "@ocpp/core/session/event"
import { SessionMessage } from "@ocpp/core/session/message"
import { Money } from "@ocpp/schema/money"
import { Base64, FileAttachment } from "@ocpp/schema/prompt"
import { SessionProjector } from "@ocpp/core/session/projector"
import { SessionInbox } from "@ocpp/core/session/inbox"
import { Shell } from "@ocpp/schema/shell"
import { InstructionStateTable, SessionInboxTable, SessionMessageTable, SessionTable } from "@ocpp/core/session/sql"
import { testEffect } from "./lib/effect"
import { Snapshot } from "@ocpp/core/snapshot"
import { CodeModeBindingTable } from "@ocpp/core/codemode/sql"
import { TestStepHost } from "./fixture/step-host"

const steps = TestStepHost.make()
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionInbox.node, Session.node]),
    [[Bus.node, Bus.configured()], steps.replacement],
  ),
)

const sessionsLayer = AppNodeBuilder.build(Session.node, [steps.replacement])
const sessionID = Session.ID.make("ses_projector_test")
const created = DateTime.makeUnsafe(0)
const model = { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }
const previousModel = { ...model, variant: Model.VariantID.make("medium") }
const encodeMessage = Schema.encodeSync(SessionMessage.Info)
const build = Agent.defaultID

const assistantRow = (
  id: SessionMessage.ID,
  seq: number,
  time: { created: DateTime.Utc; completed?: DateTime.Utc } = { created },
  usage?: Pick<SessionMessage.Assistant, "cost" | "tokens">,
) => {
  const {
    id: _,
    type,
    ...data
  } = encodeMessage(
    SessionMessage.Assistant.make({ id, type: "assistant", agent: build, model, content: [], time, ...usage }),
  )
  return { id, session_id: sessionID, type, seq, time_created: DateTime.toEpochMillis(time.created), data }
}

const executeTool = (row: typeof SessionMessageTable.$inferSelect) => {
  const message = Schema.decodeUnknownSync(SessionMessage.Info)({ ...row.data, id: row.id, type: row.type })
  if (message.type !== "assistant") throw new Error("Expected an assistant message")
  const part = message.content[0]
  if (part?.type !== "tool" || part.state.status !== "completed") throw new Error("Expected a completed tool part")
  return part.state
}

const seedSession = (overrides?: Partial<typeof SessionTable.$inferInsert>) =>
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .run()
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
        ...overrides,
      })
      .run()
    return db
  })

describe("SessionProjector", () => {
  it.effect("does not settle a pending manual compaction on an auto failure", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      const bus = yield* Bus.Service
      const inbox = yield* SessionInbox.Service
      const inputID = SessionMessage.ID.make("msg_manual_compaction")
      // A step in flight keeps the compaction pending.
      const busy = yield* steps.busy(sessionID)
      yield* inbox.admitCompaction({ id: inputID, sessionID, delivery: "queue" })

      yield* bus.publish(SessionEvent.Compaction.Failed, {
        sessionID,
        reason: "auto",
        error: { type: "compaction.failed", message: "Auto compaction failed" },
      })

      expect(yield* SessionInbox.find(db, inputID)).toMatchObject({ id: inputID })
      yield* busy.release
    }),
  )

  it.effect("projects staged, cleared, and committed reverts", () =>
    Effect.gen(function* () {
      const db = yield* seedSession({
        cost: 1.25,
        tokens_input: 10,
        tokens_output: 4,
        tokens_reasoning: 2,
        tokens_cache_read: 3,
        tokens_cache_write: 1,
      })
      const boundary = SessionMessage.ID.make("msg_boundary")
      const earlier = SessionMessage.ID.make("msg_earlier")
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(earlier, 0),
          assistantRow(
            boundary,
            1,
            { created },
            {
              cost: Money.USD.make(0.5),
              tokens: { input: 4, output: 1, reasoning: 1, cache: { read: 1, write: 0 } },
            },
          ),
          assistantRow(
            SessionMessage.ID.make("msg_later"),
            2,
            { created },
            {
              cost: Money.USD.make(0.75),
              tokens: { input: 6, output: 3, reasoning: 1, cache: { read: 2, write: 1 } },
            },
          ),
        ])
        .run()
      yield* db
        .insert(InstructionStateTable)
        .values({
          session_id: sessionID,
          epoch_start: 0,
          through_seq: 0,
          initial_values: {},
          current_values: {},
        })
        .run()
      yield* db
        .insert(CodeModeBindingTable)
        .values([
          { session_id: sessionID, name: "early", message_seq: 0, value: 1, execution_id: "exe_early" },
          { session_id: sessionID, name: "late", message_seq: 1, value: 2, execution_id: "exe_late" },
        ])
        .run()
      const bus = yield* Bus.Service
      yield* bus.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        revert: { messageID: boundary, snapshot: Snapshot.ID.make("tree"), files: [] },
      })
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toMatchObject({
        messageID: boundary,
        snapshot: "tree",
        files: [],
      })
      yield* bus.publish(SessionEvent.RevertEvent.Cleared, { sessionID })
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toBeNull()
      yield* bus.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        revert: { messageID: boundary, files: [] },
      })
      yield* bus.publish(SessionEvent.RevertEvent.Committed, {
        sessionID,
        to: boundary,
      })
      expect(
        (yield* db.select({ id: SessionMessageTable.id }).from(SessionMessageTable).all()).map((row) => row.id),
      ).toEqual([earlier])
      expect(yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get()).toMatchObject({
        cost: Money.USD.make(1.25),
        tokens_input: 10,
        tokens_output: 4,
        tokens_reasoning: 2,
        tokens_cache_read: 3,
        tokens_cache_write: 1,
      })
      // A committed revert removes the notebook values saved from its boundary onward.
      expect((yield* db.select().from(CodeModeBindingTable).all()).map((row) => row.name)).toEqual(["early"])
      // A committed revert resets the fold cache so the next boundary establishes a new epoch.
      expect(yield* db.select().from(InstructionStateTable).get().pipe(Effect.orDie)).toBeUndefined()
      // That new epoch checkpoints the notebook left after the revert.
      yield* bus.publish(SessionEvent.InstructionsUpdated, { sessionID, delta: {} })
      expect((yield* db.select().from(InstructionStateTable).get().pipe(Effect.orDie))?.notebook).toEqual(["early"])
    }),
  )

  it.effect("forks notebook bindings through the copied message boundary", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      const bus = yield* Bus.Service
      const boundary = SessionMessage.ID.make("msg_fork_boundary")
      const later = SessionMessage.ID.make("msg_fork_later")
      const child = Session.ID.make("ses_projector_fork")
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(boundary, 0, { created, completed: created }),
          assistantRow(later, 1, { created, completed: created }),
        ])
        .run()
      yield* db
        .insert(CodeModeBindingTable)
        .values([
          { session_id: sessionID, name: "early", message_seq: 0, value: 1, execution_id: "exe_early" },
          { session_id: sessionID, name: "late", message_seq: 1, value: 2, execution_id: "exe_late" },
        ])
        .run()

      yield* bus.publish(SessionEvent.Forked, {
        sessionID: child,
        parentID: sessionID,
        boundary: { type: "through", messageID: boundary },
        instructions: {},
      })

      expect(
        (yield* db.select().from(CodeModeBindingTable).where(eq(CodeModeBindingTable.session_id, child)).all()).map(
          (row) => row.name,
        ),
      ).toEqual(["early"])
      expect(
        yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, child))
          .all(),
      ).toEqual([{ seq: 0 }])
      // The fork's baseline checkpoints the values it copied, not the parent's later ones.
      expect(
        (yield* db.select().from(InstructionStateTable).where(eq(InstructionStateTable.session_id, child)).get())
          ?.notebook,
      ).toEqual(["early"])
    }),
  )

  it.effect("does not fork a tool result that promises a still-running execution", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      const bus = yield* Bus.Service
      const boundary = SessionMessage.ID.make("msg_fork_codemode")
      const child = Session.ID.make("ses_projector_fork_codemode")
      const {
        id: _,
        type,
        ...data
      } = encodeMessage(
        SessionMessage.Assistant.make({
          id: boundary,
          type: "assistant",
          agent: build,
          model,
          time: { created, completed: created },
          content: [
            SessionMessage.AssistantTool.make({
              type: "tool",
              id: "call_execute",
              name: "execute",
              time: { created, completed: created },
              state: SessionMessage.ToolStateCompleted.make({
                status: "completed",
                input: { code: "const value = 1" },
                content: [{ type: "text", text: "Execution exe_inflight started. Its outcome arrives later." }],
                metadata: { executionID: "exe_inflight", executionStatus: "running", events: [] },
              }),
            }),
          ],
        }),
      )
      yield* db
        .insert(SessionMessageTable)
        .values([{ id: boundary, session_id: sessionID, type, seq: 0, time_created: 0, data }])
        .run()

      yield* bus.publish(SessionEvent.Forked, {
        sessionID: child,
        parentID: sessionID,
        boundary: { type: "through", messageID: boundary },
      })

      const copied = yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.session_id, child)).get()
      if (!copied) return yield* Effect.die("Expected the forked message")
      const part = executeTool(copied)
      expect(part.metadata?.executionStatus).toBe("cancelled")
      expect(part.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("stayed with the") })

      // The parent keeps the in-flight result it still owns.
      const original = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .get()
      if (!original) return yield* Effect.die("Expected the original message")
      expect(executeTool(original).metadata?.executionStatus).toBe("running")
    }),
  )

  it.effect("orders projected messages and context by durable aggregate sequence", () =>
    Effect.gen(function* () {
      yield* seedSession()
      const bus = yield* Bus.Service

      // Each prompt is delivered in the commit that admits it, so it never waits in the inbox.
      yield* bus.publishAll([
        [
          SessionEvent.InboxEnqueued,
          {
            sessionID,
            inboxID: SessionMessage.ID.make("msg_first"),
            item: { type: "user", payload: { text: "first" }, delivery: "steer" },
          },
        ],
        [
          SessionEvent.InboxDelivered,
          { sessionID, inboxID: SessionMessage.ID.make("msg_first") },
          { id: Event.ID.make("evt_z") },
        ],
      ])
      yield* bus.publishAll([
        [
          SessionEvent.InboxEnqueued,
          {
            sessionID,
            inboxID: SessionMessage.ID.make("msg_second"),
            item: { type: "user", payload: { text: "second" }, delivery: "steer" },
          },
        ],
        [
          SessionEvent.InboxDelivered,
          { sessionID, inboxID: SessionMessage.ID.make("msg_second") },
          { id: Event.ID.make("evt_a") },
        ],
      ])

      const sessions = yield* Session.Service
      const firstPage = yield* sessions.messages({ sessionID, limit: 1, order: "asc" })
      expect(firstPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["first"])
      const secondPage = yield* sessions.messages({
        sessionID,
        limit: 1,
        order: "asc",
        cursor: { id: firstPage[0]!.id, direction: "next" },
      })
      expect(secondPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["second"])
      expect(
        (yield* sessions.messages({
          sessionID,
          limit: 1,
          order: "asc",
          cursor: { id: secondPage[0]!.id, direction: "previous" },
        })).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first"])
      expect(
        (yield* sessions.context(sessionID)).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first", "second"])
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("maps malformed persisted rows consistently while single-message lookup defects", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      const messageID = SessionMessage.ID.make("msg_malformed")
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: messageID,
          session_id: sessionID,
          type: "user",
          seq: 0,
          data: { text: "valid before corruption", time: { created: 0 } },
        })
        .run()
        .pipe(Effect.orDie)
      yield* db.run(sql`update session_message set data = '{"time":{"created":0}}' where id = ${messageID}`)

      const sessions = yield* Session.Service
      const expected = { _tag: "Session.MessageDecodeError", sessionID, messageID }
      expect(yield* sessions.messages({ sessionID }).pipe(Effect.flip)).toMatchObject(expected)
      expect(yield* sessions.context(sessionID).pipe(Effect.flip)).toMatchObject(expected)
      expect(yield* sessions.message({ sessionID, messageID }).pipe(Effect.catchDefect(Effect.succeed))).toMatchObject(
        expected,
      )
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("projects files attached to synthetic input at promotion", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      const bus = yield* Bus.Service
      const inbox = yield* SessionInbox.Service
      const id = SessionMessage.ID.make("msg_synthetic_media")
      const file = FileAttachment.make({
        data: Base64.make("AAECAw=="),
        mime: "image/png",
        source: { type: "inline" },
        name: "frame.png",
      })
      // Held, so it waits for the delivery below.
      const admitted = yield* inbox.admit({
        id,
        sessionID,
        resume: false,
        item: {
          type: "synthetic",
          payload: { text: "Execution completed.", files: [file], metadata: { source: "codemode" } },
          delivery: "steer",
        },
      })
      if (!admitted) return yield* Effect.die("Synthetic admission failed")

      yield* bus.publish(SessionEvent.InboxDelivered, { sessionID, inboxID: id })

      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, id))
        .get()
        .pipe(Effect.orDie)
      expect(
        Schema.decodeUnknownSync(SessionMessage.Info)({ ...row?.data, id: row?.id, type: row?.type }),
      ).toMatchObject({ type: "synthetic", text: "Execution completed.", files: [file] })
    }),
  )

  it.effect("consumes the pending row and projects the message at promotion", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      const bus = yield* Bus.Service
      const inbox = yield* SessionInbox.Service
      const id = SessionMessage.ID.make("msg_admitted")
      // Held, so it waits for the delivery below.
      const admitted = yield* inbox.admit({
        id,
        sessionID,
        resume: false,
        item: { type: "user", payload: { text: "promote me" }, delivery: "steer" },
      })
      if (!admitted) return yield* Effect.die("Prompt admission failed")

      const event = yield* bus.publish(SessionEvent.InboxDelivered, {
        sessionID,
        inboxID: id,
      })

      expect(
        yield* db.select().from(SessionInboxTable).where(eq(SessionInboxTable.id, id)).get().pipe(Effect.orDie),
      ).toBeUndefined()
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ session_id: sessionID, type: "user", seq: event.durable?.seq })
    }),
  )

  it.effect("projects durable context messages supported by the updater", () =>
    Effect.gen(function* () {
      const db = yield* seedSession({ agent: "plan", model: previousModel })
      const bus = yield* Bus.Service

      yield* bus.publish(SessionEvent.AgentSelected, {
        sessionID,
        agent: build,
      })
      yield* bus.publish(SessionEvent.ModelSelected, {
        sessionID,
        model,
      })
      yield* bus.publish(SessionEvent.Synthetic, {
        sessionID,
        text: "synthetic context",
        metadata: { source: "projector-test" },
      })
      // No transient envelope metadata supplies the background marker: it comes from the event's data.
      yield* bus.publish(SessionEvent.Shell.Started, {
        sessionID,
        shell: Shell.Info.make({
          id: Shell.ID.make("sh_projector"),
          status: "running",
          command: "pwd",
          cwd: "/project",
          shell: "/bin/sh",
          file: "/tmp/sh_projector.out",
          metadata: { background: true },
          time: { started: 0 },
        }),
      })
      yield* bus.publish(SessionEvent.Shell.Ended, {
        sessionID,
        shell: Shell.Info.make({
          id: Shell.ID.make("sh_projector"),
          status: "exited",
          command: "pwd",
          cwd: "/project",
          shell: "/bin/sh",
          file: "/tmp/sh_projector.out",
          exit: 0,
          metadata: {},
          time: { started: 0, completed: 1 },
        }),
        output: { output: "/project", cursor: 8, size: 8, truncated: false },
      })
      yield* bus.publish(SessionEvent.Compaction.Started, {
        sessionID,
        reason: "manual",
        recent: "recent context",
      })
      yield* bus.publish(SessionEvent.Compaction.Delta, {
        sessionID,
        text: "partial",
      })
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(sql`${EventTable.type} like 'session.compaction.delta.%'`)
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(0)
      expect(
        yield* db
          .select({ data: SessionMessageTable.data })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.type, "compaction"))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([{ data: expect.objectContaining({ status: "running", summary: "", recent: "recent context" }) }])
      yield* bus.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        reason: "manual",
        text: "summary",
        recent: "recent context",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Info)({ ...row.data, id: row.id, type: row.type }),
      )

      expect(messages.map((message) => message.type)).toEqual([
        "agent-switched",
        "model-switched",
        "synthetic",
        "shell",
        "compaction",
      ])
      expect(messages.find((message) => message.type === "synthetic")).toMatchObject({
        text: "synthetic context",
        metadata: { source: "projector-test" },
      })
      expect(messages.find((message) => message.type === "agent-switched")).toMatchObject({
        agent: build,
        previous: "plan",
      })
      expect(messages.find((message) => message.type === "model-switched")).toMatchObject({ previous: previousModel })
      expect(messages.find((message) => message.type === "shell")).toMatchObject({
        command: "pwd",
        status: "exited",
        exit: 0,
        metadata: { background: true },
        output: { output: "/project", truncated: false },
        time: { completed: DateTime.makeUnsafe(0) },
      })
      expect(messages.find((message) => message.type === "compaction")).toMatchObject({
        summary: "summary",
        recent: "recent context",
      })
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        agent: "build",
        model,
        time_updated: DateTime.toEpochMillis(created),
      })
    }),
  )

  it.effect("rejects distinct creator events that reuse one projected message ID", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      const bus = yield* Bus.Service
      const id = SessionMessage.ID.make("msg_creator_collision")
      const { id: _, type, ...data } = encodeMessage({ id, type: "synthetic", text: "existing", time: { created } })
      yield* db
        .insert(SessionMessageTable)
        .values({ id, session_id: sessionID, type, seq: 0, time_created: 0, data })
        .run()

      const exit = yield* bus
        .publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID: id,
          agent: build,
          model,
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ type: "synthetic" })
    }),
  )

  it.effect("projects retry state and clears it at the next step or execution terminal", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      const bus = yield* Bus.Service
      const first = SessionMessage.ID.make("msg_retry_first")
      const second = SessionMessage.ID.make("msg_retry_second")
      yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: first, agent: build, model })
      yield* bus.publish(SessionEvent.RetryScheduled, {
        sessionID,
        assistantMessageID: first,
        attempt: 2,
        at: 2_000,
        error: { type: "provider.transport", message: "Disconnected" },
      })

      const decode = (row: typeof SessionMessageTable.$inferSelect) =>
        Schema.decodeUnknownSync(SessionMessage.Info)({ ...row.data, id: row.id, type: row.type })
      const firstRow = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, first))
        .get()
        .pipe(Effect.orDie)
      const projected = firstRow ?? (yield* Effect.die(new Error("Missing retry projection")))
      expect(decode(projected)).toMatchObject({
        retry: { attempt: 2, at: DateTime.makeUnsafe(2_000), error: { type: "provider.transport" } },
      })

      yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: second, agent: build, model })
      yield* bus.publish(SessionEvent.RetryScheduled, {
        sessionID,
        assistantMessageID: second,
        attempt: 3,
        at: 6_000,
        error: { type: "provider.internal", message: "Unavailable" },
      })
      yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID, reason: "shutdown" })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      expect(decode(rows[0])).not.toHaveProperty("retry")
      expect(decode(rows[1])).not.toHaveProperty("retry")
    }),
  )

  it.effect("updates only the newest incomplete assistant projection", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_1"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_2"), 1),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* Bus.Service
      const usageUpdated = yield* service
        .subscribe(SessionEvent.UsageUpdated)
        .pipe(Stream.runHead, Effect.forkScoped({ startImmediately: true }))
      yield* service.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID: SessionMessage.ID.make("msg_assistant_2"),
        finish: "stop",
        cost: Money.USD.make(1.25),
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Info)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages[0]).not.toHaveProperty("time.completed")
      expect(messages[1]).toMatchObject({
        type: "assistant",
        finish: "stop",
        cost: Money.USD.make(1.25),
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
        time: { completed: DateTime.makeUnsafe(0) },
      })
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        cost: 1.25,
        tokens_input: 10,
        tokens_output: 4,
        tokens_reasoning: 2,
        tokens_cache_read: 3,
        tokens_cache_write: 1,
      })
      expect(Option.getOrThrow(yield* Fiber.join(usageUpdated)).data).toEqual({
        sessionID,
        cost: Money.USD.make(1.25),
        tokens: { input: 10, output: 4, reasoning: 2, cache: { read: 3, write: 1 } },
      })
    }),
  )

  it.effect("projects ended and failed step terminal state", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      const endedID = SessionMessage.ID.make("msg_ended")
      const failedID = SessionMessage.ID.make("msg_failed")
      yield* db
        .insert(SessionMessageTable)
        .values([assistantRow(endedID, 0), assistantRow(failedID, 1)])
        .run()
        .pipe(Effect.orDie)

      const service = yield* Bus.Service
      yield* service.publish(SessionEvent.Step.Streamed, {
        sessionID,
        assistantMessageID: endedID,
      })
      yield* service.publish(SessionEvent.Step.Ended, {
        sessionID,
        assistantMessageID: endedID,
        finish: "stop",
        rawFinish: "stop_sequence",
        providerState: { response: "ended" },
        cost: Money.USD.make(1),
        tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } },
        snapshot: Snapshot.ID.make("snap_ended"),
        files: [RelativePath.make("src/ended.ts")],
      })
      yield* service.publish(SessionEvent.Step.Failed, {
        sessionID,
        assistantMessageID: failedID,
        finish: "content-filter",
        rawFinish: "blocked",
        providerState: { response: "failed" },
        error: { type: "provider.invalid-request", message: "Failed" },
        snapshot: Snapshot.ID.make("snap_failed"),
        files: [RelativePath.make("src/failed.ts")],
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Info)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages[0]).toMatchObject({
        type: "assistant",
        finish: "stop",
        rawFinish: "stop_sequence",
        providerState: { response: "ended" },
        cost: Money.USD.make(1),
        tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } },
        snapshot: { end: "snap_ended", files: ["src/ended.ts"] },
        time: { streamed: created, completed: created },
      })
      expect(messages[1]).toMatchObject({
        type: "assistant",
        finish: "content-filter",
        rawFinish: "blocked",
        providerState: { response: "failed" },
        error: { type: "provider.invalid-request", message: "Failed" },
        snapshot: { end: "snap_failed", files: ["src/failed.ts"] },
        time: { completed: created },
      })
    }),
  )

  it.effect("does not revive a stale incomplete assistant projection", () =>
    Effect.gen(function* () {
      const db = yield* seedSession()
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_stale"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_completed"), 1, {
            created: DateTime.makeUnsafe(1),
            completed: DateTime.makeUnsafe(2),
          }),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* Bus.Service
      yield* service.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID: SessionMessage.ID.make("msg_assistant_completed"),
        ordinal: 0,
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Info)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages).toEqual([
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_assistant_completed"),
          type: "assistant",
          agent: build,
          model,
          content: [SessionMessage.AssistantText.make({ type: "text", text: "" })],
          time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
        }),
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_assistant_stale"),
          type: "assistant",
          agent: build,
          model,
          content: [],
          time: { created },
        }),
      ])
    }),
  )
})
