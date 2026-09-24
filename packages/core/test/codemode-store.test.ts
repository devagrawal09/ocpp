import { describe, expect } from "bun:test"
import { CodeMode } from "@ocpp/codemode"
import { Agent } from "@ocpp/core/agent"
import { CodeModeStore } from "@ocpp/core/codemode/store"
import { limits } from "@ocpp/core/codemode/limits"
import { CodeModeBindingTable, CodeModeExecutionTable, CodeModeJournalTable } from "@ocpp/core/codemode/sql"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { Model } from "@ocpp/core/model"
import { Project } from "@ocpp/core/project"
import { ProjectTable } from "@ocpp/core/project/sql"
import { Provider } from "@ocpp/core/provider"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { SessionMessage } from "@ocpp/core/session/message"
import { SessionMessageTable, SessionTable } from "@ocpp/core/session/sql"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([CodeModeStore.node, Database.node])))
const parent = Session.ID.make("ses_codemode_store_parent")
const child = Session.ID.make("ses_codemode_store_child")
const emptyChild = Session.ID.make("ses_codemode_store_empty_child")
const firstMessage = SessionMessage.ID.make("msg_codemode_store_1")
const secondMessage = SessionMessage.ID.make("msg_codemode_store_2")
const model = { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Info)

function message(id: SessionMessage.ID, sessionID: Session.ID, seq: number) {
  const encoded = encodeMessage(
    SessionMessage.Assistant.make({
      id,
      type: "assistant",
      agent: Agent.defaultID,
      model,
      content: [],
      time: { created: DateTime.makeUnsafe(seq), completed: DateTime.makeUnsafe(seq) },
    }),
  )
  const { id: _, type, ...data } = encoded
  return { id, session_id: sessionID, type, seq, time_created: seq, data }
}

const seed = Effect.fnUntraced(function* () {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .run()
  yield* db
    .insert(SessionTable)
    .values(
      [parent, child, emptyChild].map((id) => ({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: AbsolutePath.make("/project"),
        title: id,
        version: "test",
      })),
    )
    .run()
  yield* db
    .insert(SessionMessageTable)
    .values([message(firstMessage, parent, 1), message(secondMessage, parent, 2)])
    .run()
  return db
})

function admit(
  store: CodeModeStore.Interface,
  input: { id: string; sessionID?: Session.ID; messageID?: SessionMessage.ID; source: string },
) {
  return store.admit({
    id: input.id,
    sessionID: input.sessionID ?? parent,
    assistantMessageID: input.messageID ?? firstMessage,
    toolCallID: "call_" + input.id,
    program: CodeMode.compile(input.source),
  })
}

const admitted = Effect.fnUntraced(function* (
  store: CodeModeStore.Interface,
  input: { id: string; sessionID?: Session.ID; messageID?: SessionMessage.ID; source: string },
) {
  const admission = yield* admit(store, input)
  if (!admission.ok) throw new Error("Expected admission: " + admission.message)
  return admission.execution
})

describe("CodeModeStore", () => {
  it.effect("reserves every declared name atomically and saves them together", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const store = yield* CodeModeStore.Service
      const execution = yield* admitted(store, { id: "exe_pair", source: "const first = 1\nconst second = 2" })

      expect(yield* store.reservations(parent)).toEqual([
        { name: "first", owner: "exe_pair" },
        { name: "second", owner: "exe_pair" },
      ])
      const row = yield* db
        .select({ program: CodeModeExecutionTable.program, version: CodeModeExecutionTable.ir_version })
        .from(CodeModeExecutionTable)
        .where(eq(CodeModeExecutionTable.id, execution.id))
        .get()
      expect(row?.program).toEqual(execution.program)
      expect(row?.version).toBe(CodeMode.IR_VERSION)

      expect(yield* store.commit(execution, { first: 1, second: 2 })).toEqual({
        status: "saved",
        saved: ["first", "second"],
      })
      expect(yield* store.bindings(parent)).toEqual({ first: 1, second: 2 })
      expect(yield* store.reservations(parent)).toEqual([])
      expect(yield* store.get(execution.id)).toMatchObject({ status: "saved", saved: ["first", "second"] })
    }),
  )

  it.effect("refuses defined and reserved names immediately without admitting an execution", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const store = yield* CodeModeStore.Service
      const first = yield* admitted(store, { id: "exe_owner", source: "const shared = 1" })
      yield* store.commit(first, { shared: 1 })

      const redefined = yield* admit(store, { id: "exe_redefine", source: "const shared = 2" })
      expect(redefined).toMatchObject({ ok: false, kind: "NameAlreadyDefined", names: ["shared"] })

      const running = yield* admitted(store, { id: "exe_running", source: "const pending = 1" })
      const conflicting = yield* admit(store, { id: "exe_conflict", source: "const pending = 2\nconst other = 3" })
      expect(conflicting).toMatchObject({ ok: false, kind: "NameReserved", names: ["pending"], owner: "exe_running" })

      // A refused program is never persisted and never holds a name of its own.
      expect(
        yield* db
          .select({ id: CodeModeExecutionTable.id })
          .from(CodeModeExecutionTable)
          .where(eq(CodeModeExecutionTable.id, "exe_conflict"))
          .get(),
      ).toBeUndefined()
      expect((yield* store.reservations(parent)).map((reservation) => reservation.name)).toEqual(["pending"])

      yield* store.fail(running, "program threw")
      expect(yield* store.reservations(parent)).toEqual([])
      expect(yield* store.get(running.id)).toMatchObject({ status: "failed", error: "program threw" })
      // The released name is available again once nothing holds it.
      expect(yield* admit(store, { id: "exe_retry", source: "const pending = 2" })).toMatchObject({ ok: true })
    }),
  )

  it.effect("merges disjoint concurrent executions and fixes each snapshot at admission", () =>
    Effect.gen(function* () {
      yield* seed()
      const store = yield* CodeModeStore.Service
      const left = yield* admitted(store, { id: "exe_left", source: "const left = 1" })
      const right = yield* admitted(store, { id: "exe_right", source: "const right = 2" })
      expect(left.bindings).toEqual({})
      expect(right.bindings).toEqual({})

      expect(yield* store.commit(left, { left: 1 })).toMatchObject({ status: "saved" })
      // The later execution keeps the snapshot it was admitted with and still saves.
      expect(right.bindings).toEqual({})
      expect(yield* store.commit(right, { right: 2 })).toMatchObject({ status: "saved" })
      expect(yield* store.bindings(parent)).toEqual({ left: 1, right: 2 })

      const next = yield* admitted(store, { id: "exe_next", source: "const next = 3" })
      expect(next.bindings).toEqual({ left: 1, right: 2 })
    }),
  )

  it.effect("saves nothing when the execution no longer owns its names or its history", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const store = yield* CodeModeStore.Service
      const released = yield* admitted(store, { id: "exe_released", source: "const released = 1" })
      yield* store.fail(released, "released early")
      expect(yield* store.commit(released, { released: 1 })).toMatchObject({
        status: "failed",
        saved: [],
        error: expect.stringContaining("no longer reserved"),
      })
      expect(yield* store.bindings(parent)).toEqual({})

      const reverted = yield* admitted(store, {
        id: "exe_reverted",
        messageID: secondMessage,
        source: "const reverted = 1",
      })
      yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.id, secondMessage)).run()
      expect(yield* store.commit(reverted, { reverted: 1 })).toMatchObject({
        status: "failed",
        error: expect.stringContaining("reverted"),
      })
      expect(yield* store.bindings(parent)).toEqual({})
      expect(yield* store.reservations(parent)).toEqual([])
    }),
  )

  it.effect("refuses a program that declares more names than one execution may save", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const store = yield* CodeModeStore.Service
      const source = Array.from({ length: limits.maxDeclarationsPerExecution + 1 }, (_, index) => {
        return "const name" + index + " = " + index
      }).join("\n")

      const refused = yield* admit(store, { id: "exe_too_many", source })
      expect(refused).toMatchObject({ ok: false, kind: "NotebookLimitExceeded" })
      if (!refused.ok) expect(refused.message).toContain(String(limits.maxDeclarationsPerExecution))
      // Refusal happens before anything is written, so no name is left reserved.
      expect(yield* store.reservations(parent)).toEqual([])
      expect(
        yield* db
          .select({ id: CodeModeExecutionTable.id })
          .from(CodeModeExecutionTable)
          .where(eq(CodeModeExecutionTable.id, "exe_too_many"))
          .get(),
      ).toBeUndefined()
    }),
  )

  it.effect("refuses growth past the cumulative notebook limits at admission and at commit", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const store = yield* CodeModeStore.Service
      const filler = Array.from({ length: limits.maxNotebookValues }, (_, index) => ({
        session_id: parent,
        name: "stored" + index,
        value: index as CodeMode.NotebookValue,
        message_seq: 1,
        execution_id: "exe_seeded",
      }))
      yield* db.insert(CodeModeBindingTable).values(filler).run()

      const refused = yield* admit(store, { id: "exe_over_count", source: "const overflow = 1" })
      expect(refused).toMatchObject({ ok: false, kind: "NotebookLimitExceeded" })
      if (!refused.ok) expect(refused.message).toContain(String(limits.maxNotebookValues))

      // Two executions can both pass admission and only collide when they save, so the commit
      // transaction is the one that has to refuse.
      yield* db.delete(CodeModeBindingTable).where(eq(CodeModeBindingTable.session_id, parent)).run()
      const first = yield* admitted(store, { id: "exe_race_first", source: "const first = 1" })
      const second = yield* admitted(store, { id: "exe_race_second", source: "const second = 2" })
      yield* db
        .insert(CodeModeBindingTable)
        .values(filler.slice(0, limits.maxNotebookValues - 1))
        .run()

      expect(yield* store.commit(first, { first: 1 })).toMatchObject({ status: "saved" })
      const late = yield* store.commit(second, { second: 2 })
      expect(late).toMatchObject({ status: "failed", saved: [], error: expect.stringContaining("above the limit") })
      expect((yield* store.bindings(parent)).second).toBeUndefined()
      expect(yield* store.reservations(parent)).toEqual([])
    }),
  )

  it.effect("copies completed history through a fork boundary and never copies reservations", () =>
    Effect.gen(function* () {
      yield* seed()
      const store = yield* CodeModeStore.Service
      const first = yield* admitted(store, { id: "exe_fork_1", source: "const early = 1" })
      yield* store.commit(first, { early: 1 })
      const second = yield* admitted(store, {
        id: "exe_fork_2",
        messageID: secondMessage,
        source: "const late = 2",
      })
      yield* store.commit(second, { late: 2 })
      yield* admitted(store, { id: "exe_fork_pending", source: "const pending = 3" })

      yield* store.fork({ from: parent, to: emptyChild, throughSeq: -1 })
      expect(yield* store.bindings(emptyChild)).toEqual({})
      yield* store.fork({ from: parent, to: child, throughSeq: 1 })
      expect(yield* store.bindings(child)).toEqual({ early: 1 })
      expect(yield* store.reservations(child)).toEqual([])
      // The forked Session may declare a name its parent is still holding.
      expect(
        yield* admit(store, { id: "exe_fork_child", sessionID: child, source: "const pending = 9" }),
      ).toMatchObject({ ok: true })
    }),
  )

  it.effect("removes reverted history and releases the reservations it orphans", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const store = yield* CodeModeStore.Service
      const retained = yield* admitted(store, { id: "exe_revert_keep", source: "const retained = 1" })
      yield* store.commit(retained, { retained: 1 })
      const removed = yield* admitted(store, {
        id: "exe_revert_drop",
        messageID: secondMessage,
        source: "const removed = 2",
      })
      yield* store.commit(removed, { removed: 2 })
      yield* admitted(store, { id: "exe_revert_inflight", messageID: secondMessage, source: "const inflight = 3" })

      yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.id, secondMessage)).run()
      yield* store.revert({ sessionID: parent, beforeSeq: 2 })

      expect(yield* store.bindings(parent)).toEqual({ retained: 1 })
      expect(yield* store.reservations(parent)).toEqual([])
      // A reverted name is free again because its binding is gone.
      expect(yield* admit(store, { id: "exe_revert_replacement", source: "const removed = 5" })).toMatchObject({
        ok: true,
      })
    }),
  )

  it.effect("marks in-flight executions indeterminate on restart and releases their names", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const store = yield* CodeModeStore.Service
      const execution = yield* admitted(store, { id: "exe_restart", source: "const pending = 1" })
      yield* store.running(execution.id)
      yield* store.scheduleCall({ executionID: execution.id, index: 0, tool: "blocked", input: null })

      expect(yield* store.recover()).toEqual([execution.id])
      expect(yield* store.get(execution.id)).toMatchObject({
        status: "indeterminate",
        saved: [],
        error: expect.stringContaining("restarted"),
      })
      expect(yield* store.bindings(parent)).toEqual({})
      expect(yield* store.reservations(parent)).toEqual([])
      expect(
        yield* db
          .select({ status: CodeModeJournalTable.status })
          .from(CodeModeJournalTable)
          .where(eq(CodeModeJournalTable.execution_id, execution.id))
          .get(),
      ).toEqual({ status: "indeterminate" })
    }),
  )

  it.effect("bounds journal captures and settles interrupted calls as indeterminate", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const store = yield* CodeModeStore.Service
      const execution = yield* admitted(store, { id: "exe_journal", source: "return null" })
      const large = "🙂".repeat(300_000)
      yield* store.scheduleCall({ executionID: execution.id, index: 0, tool: "large", input: large })
      yield* store.settleCall({
        executionID: execution.id,
        index: 0,
        outcome: "completed",
        output: large,
        error: large,
      })
      yield* store.scheduleCall({ executionID: execution.id, index: 1, tool: "pending", input: null })
      yield* store.indeterminate(execution, "Execution was interrupted")

      expect(
        yield* db
          .select({
            input: CodeModeJournalTable.input,
            output: CodeModeJournalTable.output,
            error: CodeModeJournalTable.error,
          })
          .from(CodeModeJournalTable)
          .where(eq(CodeModeJournalTable.call_index, 0))
          .get(),
      ).toMatchObject({
        input: "[input omitted: capture limit exceeded]",
        output: "[output omitted: capture limit exceeded]",
        error: expect.not.stringContaining("�"),
      })
      expect(
        yield* db
          .select({ status: CodeModeJournalTable.status, error: CodeModeJournalTable.error })
          .from(CodeModeJournalTable)
          .where(eq(CodeModeJournalTable.call_index, 1))
          .get(),
      ).toEqual({ status: "indeterminate", error: "Execution was interrupted" })
      expect(yield* store.get(execution.id)).toMatchObject({ status: "indeterminate" })
    }),
  )

  it.effect("saves durable functions and replays them in a later execution", () =>
    Effect.gen(function* () {
      yield* seed()
      const store = yield* CodeModeStore.Service
      const source = "const factor = 3\nconst scale = (value) => value * factor"
      const first = yield* admitted(store, { id: "exe_fn", source })
      const saved = yield* Effect.promise(() => Effect.runPromise(CodeMode.execute({ code: source }))).pipe(
        Effect.map((result) => (result.ok ? result.declarations : {})),
      )
      expect(yield* store.commit(first, saved as Readonly<Record<string, CodeMode.NotebookValue>>)).toMatchObject({
        status: "saved",
      })

      const next = yield* admitted(store, { id: "exe_fn_use", source: "const scaled = scale(2)" })
      const result = yield* Effect.promise(() =>
        Effect.runPromise(CodeMode.execute({ code: next.program.source, bindings: next.bindings })),
      )
      expect(result).toMatchObject({ ok: true, declarations: { scaled: 6 } })
    }),
  )
})
