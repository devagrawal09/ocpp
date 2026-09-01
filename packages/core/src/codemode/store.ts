export * as CodeModeStore from "./store.js"

import type { CodeMode } from "@opencode-ai/codemode"
import { makeGlobalNode } from "@opencode-ai/util/effect/app-node"
import { and, asc, desc, eq, lt, lte, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database.js"
import type { SessionMessage } from "../session/message.js"
import type { SessionSchema } from "../session/schema.js"
import { SessionMessageTable } from "../session/sql.js"
import { activation as limits } from "./limits.js"
import {
  CodeModeActivationTable,
  CodeModeBindingHistoryTable,
  CodeModeBindingTable,
  CodeModeJournalTable,
  CodeModeNotebookTable,
  CodeModeResultTable,
} from "./sql.js"

export type Mode = "required" | "detached"
export type ActivationStatus = "scheduled" | "running" | "completed" | "failed" | "indeterminate"
export type ResultStatus = "completed" | "failed" | "indeterminate"

export type Activation = {
  readonly id: string
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly toolCallID: string
  readonly baseRevision: number
  readonly mode: Mode
  readonly program: CodeMode.Program
  readonly bindings: Readonly<Record<string, Schema.Json>>
}

export type StoredResult = {
  readonly activationID: string
  readonly status: ResultStatus
  readonly result: CodeMode.Result
  readonly bytes: number
}

export type ResultPage = StoredResult & {
  readonly offset: number
  readonly content: string
  readonly next: number | null
}

export interface Interface {
  readonly begin: (input: Omit<Activation, "baseRevision" | "bindings">) => Effect.Effect<Activation>
  readonly running: (activationID: string) => Effect.Effect<void>
  readonly scheduleCall: (input: {
    activationID: string
    index: number
    tool: string
    input: Schema.Json
  }) => Effect.Effect<void>
  readonly settleCall: (input: {
    activationID: string
    index: number
    outcome: "completed" | "failed" | "indeterminate"
    output?: Schema.Json
    error?: string
  }) => Effect.Effect<void>
  readonly complete: (activation: Activation, result: CodeMode.Result) => Effect.Effect<StoredResult>
  readonly discardScheduled: (activationID: string) => Effect.Effect<void>
  readonly indeterminate: (activation: Activation, message: string) => Effect.Effect<void>
  readonly getResult: (activationID: string) => Effect.Effect<StoredResult | undefined>
  readonly resultPage: (input: {
    activationID: string
    sessionID: SessionSchema.ID
    offset?: number
    limit?: number
  }) => Effect.Effect<ResultPage | undefined>
  readonly bindings: (sessionID: SessionSchema.ID) => Effect.Effect<Readonly<Record<string, Schema.Json>>>
  readonly fork: (input: { from: SessionSchema.ID; to: SessionSchema.ID; throughSeq: number }) => Effect.Effect<void>
  readonly revert: (input: { sessionID: SessionSchema.ID; beforeSeq: number }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/CodeModeStore") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const readBindings = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      return Object.fromEntries(
        (yield* db
          .select({ name: CodeModeBindingTable.name, value: CodeModeBindingTable.value })
          .from(CodeModeBindingTable)
          .where(eq(CodeModeBindingTable.session_id, sessionID))
          .orderBy(asc(CodeModeBindingTable.name))
          .all()
          .pipe(Effect.orDie)).map((row) => [row.name, row.value]),
      )
    })

    const begin: Interface["begin"] = Effect.fn("CodeModeStore.begin")((input) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.insert(CodeModeNotebookTable).values({ session_id: input.sessionID }).onConflictDoNothing().run()
            const notebook = yield* tx
              .select({ revision: CodeModeNotebookTable.revision })
              .from(CodeModeNotebookTable)
              .where(eq(CodeModeNotebookTable.session_id, input.sessionID))
              .get()
            if (!notebook) return yield* Effect.die(new Error("Code Mode notebook was not created"))
            const bindings = Object.fromEntries(
              (yield* tx
                .select({ name: CodeModeBindingTable.name, value: CodeModeBindingTable.value })
                .from(CodeModeBindingTable)
                .where(eq(CodeModeBindingTable.session_id, input.sessionID))
                .orderBy(asc(CodeModeBindingTable.name))
                .all()).map((row) => [row.name, row.value]),
            )
            yield* tx.insert(CodeModeActivationTable).values({
              id: input.id,
              session_id: input.sessionID,
              assistant_message_id: input.assistantMessageID,
              tool_call_id: input.toolCallID,
              base_revision: notebook.revision,
              mode: input.mode,
              status: "scheduled",
              program: input.program,
              ir_version: input.program.version,
            })
            return { ...input, baseRevision: notebook.revision, bindings }
          }),
        )
        .pipe(Effect.orDie),
    )

    const running: Interface["running"] = Effect.fn("CodeModeStore.running")((activationID) =>
      db
        .update(CodeModeActivationTable)
        .set({ status: "running", time_updated: Date.now() })
        .where(and(eq(CodeModeActivationTable.id, activationID), eq(CodeModeActivationTable.status, "scheduled")))
        .run()
        .pipe(Effect.orDie),
    )

    const scheduleCall: Interface["scheduleCall"] = Effect.fn("CodeModeStore.scheduleCall")((input) =>
      db
        .insert(CodeModeJournalTable)
        .values({
          activation_id: input.activationID,
          call_index: input.index,
          tool: input.tool,
          input: boundedCapture(input.input) ?? "[input omitted: capture limit exceeded]",
          status: "scheduled",
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie),
    )

    const settleCall: Interface["settleCall"] = Effect.fn("CodeModeStore.settleCall")((input) =>
      db
        .update(CodeModeJournalTable)
        .set({
          status: input.outcome,
          ...(input.output === undefined
            ? {}
            : { output: boundedCapture(input.output) ?? "[output omitted: capture limit exceeded]" }),
          ...(input.error === undefined ? {} : { error: truncate(input.error, limits.maxCaptureBytes) }),
          time_completed: Date.now(),
          time_updated: Date.now(),
        })
        .where(
          and(
            eq(CodeModeJournalTable.activation_id, input.activationID),
            eq(CodeModeJournalTable.call_index, input.index),
            eq(CodeModeJournalTable.status, "scheduled"),
          ),
        )
        .run()
        .pipe(Effect.orDie),
    )

    const complete: Interface["complete"] = Effect.fn("CodeModeStore.complete")((activation, result) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const resultBytes = new TextEncoder().encode(JSON.stringify(result)).byteLength
            const accepted: CodeMode.Result =
              resultBytes <= limits.maxResultBytes
                ? result
                : {
                    ok: false,
                    error: {
                      kind: "InvalidDataValue",
                      message:
                        "Result exceeds the " + limits.maxResultBytes + "-byte durable result limit; return less data.",
                    },
                    toolCalls: [],
                  }
            const notebook = yield* tx
              .select({ revision: CodeModeNotebookTable.revision })
              .from(CodeModeNotebookTable)
              .where(eq(CodeModeNotebookTable.session_id, activation.sessionID))
              .get()
            if (!notebook) return yield* Effect.die(new Error("Code Mode notebook is unavailable"))
            const exports = accepted.ok ? accepted.exports : undefined
            const message =
              exports !== undefined && notebook.revision === activation.baseRevision
                ? yield* tx
                    .select({ seq: SessionMessageTable.seq })
                    .from(SessionMessageTable)
                    .where(
                      and(
                        eq(SessionMessageTable.session_id, activation.sessionID),
                        eq(SessionMessageTable.id, activation.assistantMessageID),
                      ),
                    )
                    .get()
                : undefined
            const conflict =
              exports !== undefined && (notebook.revision !== activation.baseRevision || message === undefined)
            const final: CodeMode.Result = conflict
              ? {
                  ok: false,
                  error: {
                    kind: "RevisionConflict",
                    message:
                      "Notebook revision changed while this activation was running. Re-run against the current bindings.",
                  },
                  toolCalls: result.toolCalls,
                  ...(result.logs ? { logs: result.logs } : {}),
                }
              : accepted
            if (final.ok && final.exports && Object.keys(final.exports).length > 0 && message) {
              const revision = activation.baseRevision + 1
              for (const [name, value] of Object.entries(final.exports)) {
                yield* tx
                  .insert(CodeModeBindingTable)
                  .values({ session_id: activation.sessionID, name, revision, value })
                  .onConflictDoUpdate({
                    target: [CodeModeBindingTable.session_id, CodeModeBindingTable.name],
                    set: { revision, value },
                  })
                yield* tx
                  .insert(CodeModeBindingHistoryTable)
                  .values({ session_id: activation.sessionID, revision, message_seq: message.seq, name, value })
              }
              yield* tx
                .update(CodeModeNotebookTable)
                .set({ revision, time_updated: Date.now() })
                .where(eq(CodeModeNotebookTable.session_id, activation.sessionID))
            }
            const encoded = JSON.stringify(final)
            const bytes = new TextEncoder().encode(encoded).byteLength
            const status: ResultStatus = final.ok ? "completed" : "failed"
            yield* tx
              .insert(CodeModeResultTable)
              .values({ activation_id: activation.id, status, data: final, bytes })
              .onConflictDoUpdate({
                target: CodeModeResultTable.activation_id,
                set: { status, data: final, bytes, time_updated: Date.now() },
              })
            yield* tx
              .update(CodeModeActivationTable)
              .set({
                status: final.ok ? "completed" : "failed",
                ...(final.ok ? {} : { error: final.error.message }),
                time_completed: Date.now(),
                time_updated: Date.now(),
              })
              .where(eq(CodeModeActivationTable.id, activation.id))
            return { activationID: activation.id, status, result: final, bytes }
          }),
        )
        .pipe(Effect.orDie),
    )

    const discardScheduled: Interface["discardScheduled"] = Effect.fn("CodeModeStore.discardScheduled")(
      (activationID) =>
        db
          .delete(CodeModeActivationTable)
          .where(and(eq(CodeModeActivationTable.id, activationID), eq(CodeModeActivationTable.status, "scheduled")))
          .run()
          .pipe(Effect.orDie),
    )

    const indeterminate: Interface["indeterminate"] = Effect.fn("CodeModeStore.indeterminate")((activation, message) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const result: CodeMode.Result = {
              ok: false,
              error: { kind: "ExecutionFailure", message },
              toolCalls: [],
            }
            const bytes = new TextEncoder().encode(JSON.stringify(result)).length
            yield* tx
              .insert(CodeModeResultTable)
              .values({ activation_id: activation.id, status: "indeterminate", data: result, bytes })
              .onConflictDoNothing()
              .run()
            yield* tx
              .update(CodeModeJournalTable)
              .set({ status: "indeterminate", error: message, time_completed: Date.now(), time_updated: Date.now() })
              .where(
                and(
                  eq(CodeModeJournalTable.activation_id, activation.id),
                  eq(CodeModeJournalTable.status, "scheduled"),
                ),
              )
              .run()
            yield* tx
              .update(CodeModeActivationTable)
              .set({
                status: "indeterminate",
                error: message,
                time_completed: Date.now(),
                time_updated: Date.now(),
              })
              .where(
                and(
                  eq(CodeModeActivationTable.id, activation.id),
                  sql`${CodeModeActivationTable.status} in ('scheduled', 'running')`,
                ),
              )
              .run()
          }),
        )
        .pipe(Effect.orDie),
    )

    const getResult: Interface["getResult"] = Effect.fn("CodeModeStore.getResult")(function* (activationID) {
      const row = yield* db
        .select({
          status: CodeModeResultTable.status,
          result: CodeModeResultTable.data,
          bytes: CodeModeResultTable.bytes,
        })
        .from(CodeModeResultTable)
        .where(eq(CodeModeResultTable.activation_id, activationID))
        .get()
        .pipe(Effect.orDie)
      return row ? { activationID, ...row } : undefined
    })

    const resultPage: Interface["resultPage"] = Effect.fn("CodeModeStore.resultPage")(function* (input) {
      const activation = yield* db
        .select({ sessionID: CodeModeActivationTable.session_id })
        .from(CodeModeActivationTable)
        .where(
          and(
            eq(CodeModeActivationTable.id, input.activationID),
            eq(CodeModeActivationTable.session_id, input.sessionID),
          ),
        )
        .get()
        .pipe(Effect.orDie)
      if (!activation) return
      const stored = yield* getResult(input.activationID)
      if (!stored) return
      const bytes = new TextEncoder().encode(JSON.stringify(stored.result))
      const requested = Math.max(0, Math.min(input.offset ?? 0, bytes.length))
      const start = alignStart(bytes, requested)
      const limit = Math.max(1, Math.min(input.limit ?? limits.resultPageBytes, limits.resultPageBytes))
      const aligned = alignEnd(bytes, Math.min(bytes.length, start + limit))
      const end = aligned > start ? aligned : alignStart(bytes, Math.min(bytes.length, start + 1))
      return {
        ...stored,
        offset: start,
        content: new TextDecoder().decode(bytes.slice(start, end)),
        next: end < bytes.length ? end : null,
      }
    })

    const fork: Interface["fork"] = Effect.fn("CodeModeStore.fork")((input) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const source = yield* tx
              .select({ sessionID: CodeModeNotebookTable.session_id })
              .from(CodeModeNotebookTable)
              .where(eq(CodeModeNotebookTable.session_id, input.from))
              .get()
            if (!source) return
            const history = yield* tx
              .select()
              .from(CodeModeBindingHistoryTable)
              .where(
                and(
                  eq(CodeModeBindingHistoryTable.session_id, input.from),
                  lte(CodeModeBindingHistoryTable.message_seq, input.throughSeq),
                ),
              )
              .orderBy(asc(CodeModeBindingHistoryTable.revision), asc(CodeModeBindingHistoryTable.name))
              .all()
            const revision = history.at(-1)?.revision ?? 0
            yield* tx.insert(CodeModeNotebookTable).values({ session_id: input.to, revision }).onConflictDoNothing()
            if (history.length === 0) return
            yield* tx
              .insert(CodeModeBindingHistoryTable)
              .values(history.map((row) => ({ ...row, session_id: input.to })))
              .onConflictDoNothing()
            const latest = new Map<string, (typeof history)[number]>()
            for (const row of history) latest.set(row.name, row)
            yield* tx
              .insert(CodeModeBindingTable)
              .values(
                [...latest.values()].map((row) => ({
                  session_id: input.to,
                  name: row.name,
                  revision: row.revision,
                  value: row.value,
                })),
              )
              .onConflictDoNothing()
          }),
        )
        .pipe(Effect.orDie),
    )

    const revert: Interface["revert"] = Effect.fn("CodeModeStore.revert")((input) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const notebook = yield* tx
              .select({ revision: CodeModeNotebookTable.revision })
              .from(CodeModeNotebookTable)
              .where(eq(CodeModeNotebookTable.session_id, input.sessionID))
              .get()
            yield* tx.delete(CodeModeBindingTable).where(eq(CodeModeBindingTable.session_id, input.sessionID))
            const history = yield* tx
              .select({
                name: CodeModeBindingHistoryTable.name,
                value: CodeModeBindingHistoryTable.value,
                revision: CodeModeBindingHistoryTable.revision,
              })
              .from(CodeModeBindingHistoryTable)
              .where(
                and(
                  eq(CodeModeBindingHistoryTable.session_id, input.sessionID),
                  lt(CodeModeBindingHistoryTable.message_seq, input.beforeSeq),
                ),
              )
              .orderBy(asc(CodeModeBindingHistoryTable.name), desc(CodeModeBindingHistoryTable.revision))
              .all()
            const latest = new Map<string, (typeof history)[number]>()
            for (const row of history) if (!latest.has(row.name)) latest.set(row.name, row)
            const revision = (notebook?.revision ?? 0) + 1
            yield* tx
              .delete(CodeModeBindingHistoryTable)
              .where(
                and(
                  eq(CodeModeBindingHistoryTable.session_id, input.sessionID),
                  sql`${CodeModeBindingHistoryTable.message_seq} >= ${input.beforeSeq}`,
                ),
              )
            if (latest.size > 0)
              yield* tx.insert(CodeModeBindingTable).values(
                [...latest].map(([name, row]) => ({
                  session_id: input.sessionID,
                  name,
                  value: row.value,
                  revision: row.revision,
                })),
              )
            yield* tx
              .insert(CodeModeNotebookTable)
              .values({ session_id: input.sessionID, revision })
              .onConflictDoUpdate({
                target: CodeModeNotebookTable.session_id,
                set: { revision, time_updated: Date.now() },
              })
          }),
        )
        .pipe(Effect.orDie),
    )

    const orphaned = yield* db
      .select({ id: CodeModeActivationTable.id })
      .from(CodeModeActivationTable)
      .where(sql`${CodeModeActivationTable.status} in ('scheduled', 'running')`)
      .all()
      .pipe(Effect.orDie)
    yield* Effect.forEach(
      orphaned,
      (activation) => {
        const result: CodeMode.Result = {
          ok: false,
          error: {
            kind: "ExecutionFailure",
            message: "Execution became indeterminate because the host restarted before it settled.",
          },
          toolCalls: [],
        }
        const bytes = new TextEncoder().encode(JSON.stringify(result)).length
        return db
          .insert(CodeModeResultTable)
          .values({ activation_id: activation.id, status: "indeterminate", data: result, bytes })
          .onConflictDoNothing()
          .run()
      },
      { discard: true },
    ).pipe(Effect.orDie)
    yield* db
      .update(CodeModeJournalTable)
      .set({
        status: "indeterminate",
        error: "Host restarted before the tool call settled",
        time_completed: Date.now(),
      })
      .where(eq(CodeModeJournalTable.status, "scheduled"))
      .run()
      .pipe(Effect.orDie)
    yield* db
      .update(CodeModeActivationTable)
      .set({
        status: "indeterminate",
        error: "Host restarted before the activation settled",
        time_completed: Date.now(),
      })
      .where(sql`${CodeModeActivationTable.status} in ('scheduled', 'running')`)
      .run()
      .pipe(Effect.orDie)

    return Service.of({
      begin,
      running,
      scheduleCall,
      settleCall,
      complete,
      discardScheduled,
      indeterminate,
      getResult,
      resultPage,
      bindings: readBindings,
      fork,
      revert,
    })
  }),
)

function alignStart(bytes: Uint8Array, offset: number) {
  let index = offset
  while (index < bytes.length && (bytes[index] & 0xc0) === 0x80) index++
  return index
}

function alignEnd(bytes: Uint8Array, offset: number) {
  let index = offset
  while (index > 0 && index < bytes.length && (bytes[index] & 0xc0) === 0x80) index--
  return index
}

function boundedCapture(value: Schema.Json) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength <= limits.maxCaptureBytes ? value : undefined
}

function truncate(value: string, limit: number) {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length <= limit) return value
  return new TextDecoder().decode(bytes.slice(0, alignEnd(bytes, limit)))
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
