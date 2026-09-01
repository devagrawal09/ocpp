import { describe, expect } from "bun:test"
import { CodeMode } from "@opencode-ai/codemode"
import { Agent } from "@opencode-ai/core/agent"
import { CodeModeStore } from "@opencode-ai/core/codemode/store"
import { CodeModeActivationTable, CodeModeJournalTable, CodeModeNotebookTable } from "@opencode-ai/core/codemode/sql"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Model } from "@opencode-ai/core/model"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { Provider } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
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

const success = (exports?: Readonly<Record<string, Schema.Json>>, value: Schema.Json = null): CodeMode.Result => ({
  ok: true,
  value,
  ...(exports === undefined ? {} : { exports }),
  toolCalls: [],
})

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

function begin(
  store: CodeModeStore.Interface,
  input: { id: string; sessionID?: Session.ID; messageID?: SessionMessage.ID; source: string },
) {
  return store.begin({
    id: input.id,
    sessionID: input.sessionID ?? parent,
    assistantMessageID: input.messageID ?? firstMessage,
    toolCallID: "call_" + input.id,
    mode: "required",
    program: CodeMode.compile(input.source),
  })
}

describe("CodeModeStore", () => {
  it.effect("persists compiled IR and commits sibling activations transactionally", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const store = yield* CodeModeStore.Service
      const first = yield* begin(store, { id: "exe_first", source: "export const value = 1" })
      const sibling = yield* begin(store, { id: "exe_sibling", source: "export const stale = 2" })

      const row = yield* db
        .select({ program: CodeModeActivationTable.program, version: CodeModeActivationTable.ir_version })
        .from(CodeModeActivationTable)
        .where(eq(CodeModeActivationTable.id, first.id))
        .get()
      expect(row?.program).toEqual(first.program)
      expect(row?.version).toBe(CodeMode.IR_VERSION)

      expect((yield* store.complete(first, success({ value: 1 }))).status).toBe("completed")
      const conflict = yield* store.complete(sibling, success({ stale: 2 }))
      expect(conflict.status).toBe("failed")
      expect(conflict.result).toMatchObject({ ok: false, error: { kind: "RevisionConflict" } })
      expect(yield* store.bindings(parent)).toEqual({ value: 1 })
    }),
  )

  it.effect("forks and reverts notebook bindings at message boundaries", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const store = yield* CodeModeStore.Service
      const first = yield* begin(store, { id: "exe_revision_1", source: "export const value = 1" })
      yield* store.complete(first, success({ value: 1, retained: "yes" }))
      const second = yield* begin(store, {
        id: "exe_revision_2",
        messageID: secondMessage,
        source: "export const value = 2",
      })
      yield* store.complete(second, success({ value: 2 }))

      yield* store.fork({ from: parent, to: emptyChild, throughSeq: -1 })
      expect(yield* store.bindings(emptyChild)).toEqual({})
      yield* store.fork({ from: parent, to: child, throughSeq: 1 })
      expect(yield* store.bindings(child)).toEqual({ retained: "yes", value: 1 })

      yield* store.revert({ sessionID: parent, beforeSeq: 2 })
      expect(yield* store.bindings(parent)).toEqual({ retained: "yes", value: 1 })
      expect(
        yield* db
          .select({ revision: CodeModeNotebookTable.revision })
          .from(CodeModeNotebookTable)
          .where(eq(CodeModeNotebookTable.session_id, parent))
          .get(),
      ).toEqual({ revision: 3 })

      const replacement = yield* begin(store, {
        id: "exe_revision_2_replacement",
        messageID: secondMessage,
        source: "export const value = 3",
      })
      expect(replacement.baseRevision).toBe(3)
      yield* store.complete(replacement, success({ value: 3 }))
      expect(yield* store.bindings(parent)).toEqual({ retained: "yes", value: 3 })
    }),
  )

  it.effect("keeps revert revisions monotonic and removes history by message boundary", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const store = yield* CodeModeStore.Service
      const removed = yield* begin(store, {
        id: "exe_removed_history",
        messageID: secondMessage,
        source: "export const removed = true",
      })
      yield* store.complete(removed, success({ removed: true }))
      const retained = yield* begin(store, {
        id: "exe_retained_history",
        messageID: firstMessage,
        source: "export const retained = true",
      })
      yield* store.complete(retained, success({ retained: true }))
      const stale = yield* begin(store, {
        id: "exe_pre_revert",
        messageID: firstMessage,
        source: "export const stale = true",
      })

      yield* store.revert({ sessionID: parent, beforeSeq: 2 })
      expect((yield* store.complete(stale, success({ stale: true }))).result).toMatchObject({
        ok: false,
        error: { kind: "RevisionConflict" },
      })
      expect(yield* store.bindings(parent)).toEqual({ retained: true })

      yield* store.fork({ from: parent, to: child, throughSeq: 2 })
      expect(yield* store.bindings(child)).toEqual({ retained: true })

      const missing = yield* begin(store, {
        id: "exe_missing_message",
        messageID: secondMessage,
        source: "export const missing = true",
      })
      yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.id, secondMessage)).run()
      expect((yield* store.complete(missing, success({ missing: true }))).result).toMatchObject({
        ok: false,
        error: { kind: "RevisionConflict" },
      })
    }),
  )

  it.effect("pages durable UTF-8 results without splitting code points", () =>
    Effect.gen(function* () {
      yield* seed()
      const store = yield* CodeModeStore.Service
      const activation = yield* begin(store, { id: "exe_pages", source: "return null" })
      const stored = yield* store.complete(activation, success(undefined, "a🙂b🙂c"))
      const pages = yield* Effect.gen(function* () {
        const output: Array<string> = []
        let offset: number | undefined
        while (true) {
          const page = yield* store.resultPage({ activationID: activation.id, sessionID: parent, offset, limit: 3 })
          expect(page).toBeDefined()
          if (!page) break
          output.push(page.content)
          if (page.next === null) break
          offset = page.next
        }
        return output
      })
      expect(pages.join("")).toBe(JSON.stringify(stored.result))
      expect(pages.every((page) => !page.includes("�"))).toBe(true)
      expect(yield* store.resultPage({ activationID: activation.id, sessionID: child })).toBeUndefined()
    }),
  )

  it.effect("fails oversized results atomically and bounds journal captures", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const store = yield* CodeModeStore.Service
      const activation = yield* begin(store, { id: "exe_limits", source: "export const value = 1" })
      const large = "🙂".repeat(300_000)
      yield* store.scheduleCall({ activationID: activation.id, index: 0, tool: "large", input: large })
      yield* store.settleCall({
        activationID: activation.id,
        index: 0,
        outcome: "completed",
        output: large,
        error: large,
      })
      const stored = yield* store.complete(activation, success({ value: large }, large))

      expect(stored).toMatchObject({
        status: "failed",
        result: { ok: false, error: { kind: "InvalidDataValue" } },
      })
      expect(stored.bytes).toBeLessThanOrEqual(1024 * 1024)
      expect(yield* store.bindings(parent)).toEqual({})
      expect(
        yield* db
          .select({
            input: CodeModeJournalTable.input,
            output: CodeModeJournalTable.output,
            error: CodeModeJournalTable.error,
          })
          .from(CodeModeJournalTable)
          .where(eq(CodeModeJournalTable.activation_id, activation.id))
          .get(),
      ).toMatchObject({
        input: "[input omitted: capture limit exceeded]",
        output: "[output omitted: capture limit exceeded]",
        error: expect.not.stringContaining("�"),
      })
    }),
  )

  it.effect("settles interrupted activations and pending calls as indeterminate", () =>
    Effect.gen(function* () {
      const db = yield* seed()
      const store = yield* CodeModeStore.Service
      const activation = yield* begin(store, { id: "exe_interrupted", source: "return null" })
      yield* store.running(activation.id)
      yield* store.scheduleCall({ activationID: activation.id, index: 0, tool: "blocked", input: null })
      yield* store.indeterminate(activation, "Execution was interrupted")

      expect(yield* store.getResult(activation.id)).toMatchObject({
        status: "indeterminate",
        result: { ok: false, error: { kind: "ExecutionFailure", message: "Execution was interrupted" } },
      })
      expect(
        yield* db
          .select({ status: CodeModeActivationTable.status, error: CodeModeActivationTable.error })
          .from(CodeModeActivationTable)
          .where(eq(CodeModeActivationTable.id, activation.id))
          .get(),
      ).toEqual({ status: "indeterminate", error: "Execution was interrupted" })
      expect(
        yield* db
          .select({ status: CodeModeJournalTable.status, error: CodeModeJournalTable.error })
          .from(CodeModeJournalTable)
          .where(eq(CodeModeJournalTable.activation_id, activation.id))
          .get(),
      ).toEqual({ status: "indeterminate", error: "Execution was interrupted" })
    }),
  )
})
