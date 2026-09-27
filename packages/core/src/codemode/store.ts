export * as CodeModeStore from "./store.js"

import type { CodeMode } from "@ocpp/codemode"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { and, eq, gte, inArray, lte, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database.js"
import { Job } from "../job.js"
import type { SessionMessage } from "../session/message.js"
import type { SessionSchema } from "../session/schema.js"
import { SessionMessageTable } from "../session/sql.js"
import { limits } from "./limits.js"
import { CodeModeBindingTable, CodeModeExecutionTable, CodeModeJournalTable, CodeModeReservationTable } from "./sql.js"

export type Status = "scheduled" | "running" | "saved" | "failed" | "indeterminate"

export type Execution = {
  readonly id: string
  readonly sessionID: SessionSchema.ID
  readonly assistantMessageID: SessionMessage.ID
  readonly toolCallID: string
  readonly program: CodeMode.Program
  /** Machine input exposed to the program as `input`. */
  readonly input?: CodeMode.DataValue
  /** Completed notebook values captured when this execution was admitted. */
  readonly bindings: Readonly<Record<string, CodeMode.NotebookValue>>
}

/** One journaled tool call of an execution being resumed, in call order. */
export type JournalEntry = {
  readonly index: number
  readonly tool: string
  readonly input: unknown
  readonly status: "scheduled" | "completed" | "failed" | "indeterminate"
  readonly output: unknown
  readonly error: string | undefined
  readonly omitted: boolean
  readonly impure: ReadonlyArray<number>
  readonly progress: Readonly<Record<string, unknown>> | undefined
}

/** An execution that was running when its host stopped, with everything needed to replay it. */
export type Resumable = {
  readonly execution: Execution
  readonly journal: ReadonlyArray<JournalEntry>
  /** Resumes including this one. */
  readonly resumes: number
  /** Snapshot names whose values no longer exist, so the run cannot see what it saw before. */
  readonly missing: ReadonlyArray<string>
}

/** Why a program was refused before it received an execution ID. */
export type Refusal = {
  readonly kind: "NameAlreadyDefined" | "NameReserved" | "NotebookLimitExceeded"
  readonly names: ReadonlyArray<string>
  readonly owner?: string
  readonly message: string
}

export type Admission = { readonly ok: true; readonly execution: Execution } | ({ readonly ok: false } & Refusal)

export type Settlement = {
  readonly status: Extract<Status, "saved" | "failed">
  readonly saved: ReadonlyArray<string>
  readonly error?: string
}

export interface Interface {
  readonly admit: (input: Omit<Execution, "bindings">) => Effect.Effect<Admission>
  readonly running: (executionID: string) => Effect.Effect<void>
  readonly scheduleCall: (input: {
    executionID: string
    index: number
    tool: string
    input: unknown
    /** Impure helper values the program read since the previous call. */
    impure?: ReadonlyArray<number>
  }) => Effect.Effect<void>
  /** Records the latest progress of a call that can rejoin its work after a restart. */
  readonly progressCall: (input: {
    executionID: string
    index: number
    progress: Readonly<Record<string, unknown>>
  }) => Effect.Effect<void>
  readonly settleCall: (input: {
    executionID: string
    index: number
    outcome: "completed" | "failed" | "indeterminate"
    output?: unknown
    error?: string
  }) => Effect.Effect<void>
  readonly commit: (
    execution: Execution,
    declarations: Readonly<Record<string, CodeMode.NotebookValue>>,
  ) => Effect.Effect<Settlement>
  readonly fail: (execution: Execution, error: string) => Effect.Effect<void>
  readonly indeterminate: (execution: Execution, error: string) => Effect.Effect<void>
  readonly discard: (executionID: string) => Effect.Effect<void>
  /**
   * Settles executions that restart recovery can never resume, saving nothing and releasing their
   * names: those admitted but never started, and running ones without a pending background marker,
   * such as one whose job ended without settling it. Runs at startup. Running executions with a
   * marker are left to restart recovery, which resumes them by replay or settles them itself.
   */
  readonly recover: () => Effect.Effect<ReadonlyArray<string>>
  /**
   * Claims one more resume of a running execution and loads its program, snapshot, and journal.
   * Undefined when the execution is no longer running.
   */
  readonly resume: (executionID: string) => Effect.Effect<Resumable | undefined>
  readonly get: (executionID: string) => Effect.Effect<
    | {
        readonly id: string
        readonly status: Status
        readonly saved: ReadonlyArray<string>
        readonly error: string | undefined
      }
    | undefined
  >
  readonly bindings: (sessionID: SessionSchema.ID) => Effect.Effect<Readonly<Record<string, CodeMode.NotebookValue>>>
  readonly reservations: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<{ name: string; owner: string }>>
  readonly fork: (input: { from: SessionSchema.ID; to: SessionSchema.ID; throughSeq: number }) => Effect.Effect<void>
  readonly revert: (input: { sessionID: SessionSchema.ID; beforeSeq: number }) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/CodeModeStore") {}

const RESTART_MESSAGE = "Execution became indeterminate because the host restarted before it settled."

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const jobs = yield* Job.Service

    const readBindings: Interface["bindings"] = Effect.fnUntraced(function* (sessionID) {
      return Object.fromEntries(
        (yield* db
          .select({ name: CodeModeBindingTable.name, value: CodeModeBindingTable.value })
          .from(CodeModeBindingTable)
          .where(eq(CodeModeBindingTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie)).map((row) => [row.name, row.value]),
      )
    })

    // Names are verified and reserved in one transaction, so an execution only receives an ID once
    // every name it will save belongs to it alone.
    const admit: Interface["admit"] = Effect.fn("CodeModeStore.admit")((input) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const names = [...input.program.declarations]
            if (names.length > limits.maxDeclarationsPerExecution)
              return {
                ok: false as const,
                kind: "NotebookLimitExceeded" as const,
                names,
                message:
                  "One execution may declare at most " +
                  limits.maxDeclarationsPerExecution +
                  " notebook names, and this program declares " +
                  names.length +
                  ". Split it into smaller executions, or publish fewer, larger values.",
              }
            const bindings = yield* tx
              .select({ name: CodeModeBindingTable.name, value: CodeModeBindingTable.value })
              .from(CodeModeBindingTable)
              .where(eq(CodeModeBindingTable.session_id, input.sessionID))
              .all()
            const totals = yield* tx
              .select(notebookTotals)
              .from(CodeModeBindingTable)
              .where(eq(CodeModeBindingTable.session_id, input.sessionID))
              .get()
            const growth = exceededNotebook(bindings.length + names.length, totals?.bytes ?? 0)
            if (growth) return { ok: false as const, kind: "NotebookLimitExceeded" as const, names, message: growth }
            const defined = names.filter((name) => bindings.some((binding) => binding.name === name))
            if (defined.length > 0)
              return {
                ok: false as const,
                kind: "NameAlreadyDefined" as const,
                names: defined,
                message:
                  "Notebook names are immutable and cannot be redefined: " + defined.join(", ") + ". Choose new names.",
              }
            const reserved =
              names.length === 0
                ? []
                : yield* tx
                    .select({ name: CodeModeReservationTable.name, owner: CodeModeReservationTable.execution_id })
                    .from(CodeModeReservationTable)
                    .where(
                      and(
                        eq(CodeModeReservationTable.session_id, input.sessionID),
                        inArray(CodeModeReservationTable.name, names),
                      ),
                    )
                    .all()
            const owner = reserved[0]
            if (owner)
              return {
                ok: false as const,
                kind: "NameReserved" as const,
                names: reserved.map((row) => row.name),
                owner: owner.owner,
                message:
                  "Execution " +
                  owner.owner +
                  " is already running and holds these notebook names: " +
                  reserved.map((row) => row.name).join(", ") +
                  ". Wait for it to finish or choose new names.",
              }
            if (names.length > 0)
              yield* tx
                .insert(CodeModeReservationTable)
                .values(names.map((name) => ({ session_id: input.sessionID, name, execution_id: input.id })))
            yield* tx.insert(CodeModeExecutionTable).values({
              id: input.id,
              session_id: input.sessionID,
              assistant_message_id: input.assistantMessageID,
              tool_call_id: input.toolCallID,
              status: "scheduled",
              program: input.program,
              ir_version: input.program.version,
              snapshot: bindings.map((binding) => binding.name),
              ...(input.input === undefined ? {} : { input: input.input }),
            })
            return {
              ok: true as const,
              execution: {
                ...input,
                bindings: Object.fromEntries(bindings.map((binding) => [binding.name, binding.value])),
              },
            }
          }),
        )
        .pipe(Effect.orDie),
    )

    const running: Interface["running"] = Effect.fn("CodeModeStore.running")((executionID) =>
      db
        .update(CodeModeExecutionTable)
        .set({ status: "running", time_updated: Date.now() })
        .where(and(eq(CodeModeExecutionTable.id, executionID), eq(CodeModeExecutionTable.status, "scheduled")))
        .run()
        .pipe(Effect.orDie),
    )

    // A resumed run re-reaches calls that are already journaled, so the first record of a call wins.
    const scheduleCall: Interface["scheduleCall"] = Effect.fn("CodeModeStore.scheduleCall")((input) => {
      const captured = boundedCapture(input.input)
      return db
        .insert(CodeModeJournalTable)
        .values({
          execution_id: input.executionID,
          call_index: input.index,
          tool: input.tool,
          input: captured ?? "[input omitted: capture limit exceeded]",
          status: "scheduled",
          omitted: captured === undefined,
          ...(input.impure === undefined || input.impure.length === 0 ? {} : { impure: input.impure }),
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    })

    const progressCall: Interface["progressCall"] = Effect.fn("CodeModeStore.progressCall")((input) =>
      db
        .update(CodeModeJournalTable)
        .set({ progress: input.progress, time_updated: Date.now() })
        .where(
          and(
            eq(CodeModeJournalTable.execution_id, input.executionID),
            eq(CodeModeJournalTable.call_index, input.index),
          ),
        )
        .run()
        .pipe(Effect.orDie),
    )

    const settleCall: Interface["settleCall"] = Effect.fn("CodeModeStore.settleCall")((input) => {
      const output = input.output === undefined ? undefined : boundedCapture(input.output)
      // A completed call replays only from its exact result, so a result the journal could not hold
      // in full, or could not represent as JSON at all, marks the call as not replayable.
      const omitted =
        (input.outcome === "completed" && output === undefined) ||
        (input.error !== undefined && new TextEncoder().encode(input.error).byteLength > limits.maxCaptureBytes)
      return (
        db
          .update(CodeModeJournalTable)
          .set({
            status: input.outcome,
            ...(input.output === undefined ? {} : { output: output ?? "[output omitted: capture limit exceeded]" }),
            error: input.error === undefined ? null : truncate(input.error, limits.maxCaptureBytes),
            ...(omitted ? { omitted } : {}),
            time_completed: Date.now(),
            time_updated: Date.now(),
          })
          // A call a shutdown interrupted is indeterminate until a resumed run settles it again.
          .where(
            and(
              eq(CodeModeJournalTable.execution_id, input.executionID),
              eq(CodeModeJournalTable.call_index, input.index),
              inArray(CodeModeJournalTable.status, ["scheduled", "indeterminate"]),
            ),
          )
          .run()
          .pipe(Effect.orDie)
      )
    })

    // Saving verifies that this execution still owns every reserved name and that the history it was
    // admitted into still exists, so a stale worker can never write into a reverted notebook.
    const commit: Interface["commit"] = Effect.fn("CodeModeStore.commit")((execution, declarations) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const names = Object.keys(declarations)
            const held = yield* tx
              .select({ name: CodeModeReservationTable.name })
              .from(CodeModeReservationTable)
              .where(eq(CodeModeReservationTable.execution_id, execution.id))
              .all()
            const owned = new Set(held.map((row) => row.name))
            const lost = names.filter((name) => !owned.has(name))
            const message =
              lost.length > 0
                ? undefined
                : yield* tx
                    .select({ seq: SessionMessageTable.seq })
                    .from(SessionMessageTable)
                    .where(
                      and(
                        eq(SessionMessageTable.session_id, execution.sessionID),
                        eq(SessionMessageTable.id, execution.assistantMessageID),
                      ),
                    )
                    .get()
            // Concurrent executions both pass admission and only meet here, so the totals decide
            // inside this transaction. Nothing is written when they are exceeded.
            const totals = yield* tx
              .select(notebookTotals)
              .from(CodeModeBindingTable)
              .where(eq(CodeModeBindingTable.session_id, execution.sessionID))
              .get()
            const growth = exceededNotebook(
              (totals?.count ?? 0) + names.length,
              (totals?.bytes ?? 0) + encodedBytes(declarations),
            )
            const error =
              lost.length > 0
                ? "Notebook names " + lost.join(", ") + " are no longer reserved by this execution; nothing was saved."
                : message === undefined
                  ? "The message that started this execution was reverted; nothing was saved."
                  : growth === undefined
                    ? undefined
                    : growth + " Nothing was saved."
            yield* tx.delete(CodeModeReservationTable).where(eq(CodeModeReservationTable.execution_id, execution.id))
            if (error === undefined && names.length > 0)
              yield* tx.insert(CodeModeBindingTable).values(
                names.map((name) => ({
                  session_id: execution.sessionID,
                  name,
                  value: declarations[name],
                  message_seq: message?.seq ?? 0,
                  execution_id: execution.id,
                })),
              )
            yield* tx
              .update(CodeModeExecutionTable)
              .set({
                status: error === undefined ? "saved" : "failed",
                saved: error === undefined ? names : [],
                ...(error === undefined ? {} : { error }),
                time_completed: Date.now(),
                time_updated: Date.now(),
              })
              .where(eq(CodeModeExecutionTable.id, execution.id))
            return error === undefined
              ? { status: "saved" as const, saved: names }
              : { status: "failed" as const, saved: [], error }
          }),
        )
        .pipe(Effect.orDie),
    )

    const settle = (executionID: string, status: Extract<Status, "failed" | "indeterminate">, error: string) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.delete(CodeModeReservationTable).where(eq(CodeModeReservationTable.execution_id, executionID))
            yield* tx
              .update(CodeModeJournalTable)
              .set({ status: "indeterminate", error, time_completed: Date.now(), time_updated: Date.now() })
              .where(
                and(eq(CodeModeJournalTable.execution_id, executionID), eq(CodeModeJournalTable.status, "scheduled")),
              )
              .run()
            yield* tx
              .update(CodeModeExecutionTable)
              .set({ status, saved: [], error, time_completed: Date.now(), time_updated: Date.now() })
              .where(
                and(
                  eq(CodeModeExecutionTable.id, executionID),
                  sql`${CodeModeExecutionTable.status} in ('scheduled', 'running')`,
                ),
              )
              .run()
          }),
        )
        .pipe(Effect.orDie)

    const discard: Interface["discard"] = Effect.fn("CodeModeStore.discard")((executionID) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.delete(CodeModeReservationTable).where(eq(CodeModeReservationTable.execution_id, executionID))
            yield* tx
              .delete(CodeModeExecutionTable)
              .where(and(eq(CodeModeExecutionTable.id, executionID), eq(CodeModeExecutionTable.status, "scheduled")))
              .run()
          }),
        )
        .pipe(Effect.orDie),
    )

    const get: Interface["get"] = Effect.fn("CodeModeStore.get")(function* (executionID) {
      const row = yield* db
        .select({
          status: CodeModeExecutionTable.status,
          saved: CodeModeExecutionTable.saved,
          error: CodeModeExecutionTable.error,
        })
        .from(CodeModeExecutionTable)
        .where(eq(CodeModeExecutionTable.id, executionID))
        .get()
        .pipe(Effect.orDie)
      return row
        ? { id: executionID, status: row.status, saved: row.saved ?? [], error: row.error ?? undefined }
        : undefined
    })

    const reservations: Interface["reservations"] = Effect.fn("CodeModeStore.reservations")(function* (sessionID) {
      return yield* db
        .select({ name: CodeModeReservationTable.name, owner: CodeModeReservationTable.execution_id })
        .from(CodeModeReservationTable)
        .where(eq(CodeModeReservationTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
    })

    // Forks copy completed values through the fork boundary only. Reservations belong to the
    // Session that admitted them and are never inherited.
    const fork: Interface["fork"] = Effect.fn("CodeModeStore.fork")((input) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const bindings = yield* tx
              .select()
              .from(CodeModeBindingTable)
              .where(
                and(
                  eq(CodeModeBindingTable.session_id, input.from),
                  lte(CodeModeBindingTable.message_seq, input.throughSeq),
                ),
              )
              .all()
            if (bindings.length === 0) return
            yield* tx
              .insert(CodeModeBindingTable)
              .values(bindings.map((binding) => ({ ...binding, session_id: input.to })))
              .onConflictDoNothing()
          }),
        )
        .pipe(Effect.orDie),
    )

    const revert: Interface["revert"] = Effect.fn("CodeModeStore.revert")((input) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .delete(CodeModeBindingTable)
              .where(
                and(
                  eq(CodeModeBindingTable.session_id, input.sessionID),
                  gte(CodeModeBindingTable.message_seq, input.beforeSeq),
                ),
              )
              .run()
            // An in-flight execution whose message was removed must not save, so release its names
            // now instead of leaving them held until it settles.
            yield* tx
              .delete(CodeModeReservationTable)
              .where(
                and(
                  eq(CodeModeReservationTable.session_id, input.sessionID),
                  sql`${CodeModeReservationTable.execution_id} in (
                    select ${CodeModeExecutionTable.id} from ${CodeModeExecutionTable}
                    where ${CodeModeExecutionTable.session_id} = ${input.sessionID}
                      and not exists (
                        select 1 from ${SessionMessageTable}
                        where ${SessionMessageTable.session_id} = ${CodeModeExecutionTable.session_id}
                          and ${SessionMessageTable.id} = ${CodeModeExecutionTable.assistant_message_id}
                      )
                  )`,
                ),
              )
              .run()
          }),
        )
        .pipe(Effect.orDie),
    )

    const recover: Interface["recover"] = Effect.fn("CodeModeStore.recover")(function* () {
      // Restart recovery resumes an execution only through the background marker its job wrote
      // before the execution started running.
      const pending = new Set(
        (yield* jobs.pendingBackground).flatMap((background) =>
          background.recovery.kind === "codemode" ? [background.id] : [],
        ),
      )
      const orphaned = (yield* db
        .select({ id: CodeModeExecutionTable.id, status: CodeModeExecutionTable.status })
        .from(CodeModeExecutionTable)
        .where(inArray(CodeModeExecutionTable.status, ["scheduled", "running"]))
        .all()
        .pipe(Effect.orDie)).filter((execution) => execution.status === "scheduled" || !pending.has(execution.id))
      yield* Effect.forEach(orphaned, (execution) => settle(execution.id, "indeterminate", RESTART_MESSAGE), {
        discard: true,
      })
      return orphaned.map((execution) => execution.id)
    })

    const resume: Interface["resume"] = Effect.fn("CodeModeStore.resume")((executionID) =>
      db
        .transaction((tx) =>
          Effect.gen(function* () {
            const row = yield* tx
              .update(CodeModeExecutionTable)
              .set({ resumes: sql`${CodeModeExecutionTable.resumes} + 1`, time_updated: Date.now() })
              .where(and(eq(CodeModeExecutionTable.id, executionID), eq(CodeModeExecutionTable.status, "running")))
              .returning()
              .get()
            if (row === undefined) return undefined
            const bindings =
              row.snapshot.length === 0
                ? []
                : yield* tx
                    .select({ name: CodeModeBindingTable.name, value: CodeModeBindingTable.value })
                    .from(CodeModeBindingTable)
                    .where(
                      and(
                        eq(CodeModeBindingTable.session_id, row.session_id),
                        inArray(CodeModeBindingTable.name, [...row.snapshot]),
                      ),
                    )
                    .all()
            const journal = yield* tx
              .select()
              .from(CodeModeJournalTable)
              .where(eq(CodeModeJournalTable.execution_id, executionID))
              .orderBy(CodeModeJournalTable.call_index)
              .all()
            return {
              execution: {
                id: row.id,
                sessionID: row.session_id,
                assistantMessageID: row.assistant_message_id,
                toolCallID: row.tool_call_id,
                program: row.program,
                ...(row.input === null ? {} : { input: row.input }),
                bindings: Object.fromEntries(bindings.map((binding) => [binding.name, binding.value])),
              },
              journal: journal.map((entry) => ({
                index: entry.call_index,
                tool: entry.tool,
                input: entry.input,
                status: entry.status,
                output: entry.output,
                error: entry.error ?? undefined,
                omitted: entry.omitted,
                impure: entry.impure ?? [],
                progress: entry.progress ?? undefined,
              })),
              resumes: row.resumes,
              missing: row.snapshot.filter((name) => !bindings.some((binding) => binding.name === name)),
            }
          }),
        )
        .pipe(Effect.orDie),
    )

    yield* recover()

    return Service.of({
      admit,
      running,
      scheduleCall,
      progressCall,
      settleCall,
      commit,
      fail: (execution, error) => settle(execution.id, "failed", error),
      indeterminate: (execution, error) => settle(execution.id, "indeterminate", error),
      discard,
      recover,
      resume,
      get,
      bindings: readBindings,
      reservations,
      fork,
      revert,
    })
  }),
)

/** Measures the stored JSON as bytes rather than characters, matching how the limit is stated. */
const notebookTotals = {
  count: sql<number>`count(*)`,
  bytes: sql<number>`coalesce(sum(length(cast(${CodeModeBindingTable.value} as blob))), 0)`,
}

function exceededNotebook(count: number, bytes: number) {
  if (count > limits.maxNotebookValues)
    return (
      "This Session's notebook would hold " +
      count +
      " values, above the limit of " +
      limits.maxNotebookValues +
      ". Notebook names are permanent, so free space by reverting messages that saved values you no longer need."
    )
  if (bytes > limits.maxNotebookBytes)
    return (
      "This Session's notebook would hold " +
      bytes +
      " bytes, above the limit of " +
      limits.maxNotebookBytes +
      ". Publish smaller summaries and keep large artifacts in files through host tools."
    )
  return undefined
}

function encodedBytes(declarations: Readonly<Record<string, CodeMode.NotebookValue>>) {
  return Object.values(declarations).reduce<number>(
    (total, value) => total + new TextEncoder().encode(JSON.stringify(value) ?? "null").byteLength,
    0,
  )
}

function boundedCapture(value: unknown) {
  const encoded = JSON.stringify(value ?? null) ?? "null"
  return new TextEncoder().encode(encoded).byteLength <= limits.maxCaptureBytes ? (value ?? null) : undefined
}

function truncate(value: string, limit: number) {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length <= limit) return value
  let end = limit
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--
  return new TextDecoder().decode(bytes.slice(0, end))
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Job.node] })
