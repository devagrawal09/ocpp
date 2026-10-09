export * as CodeModeStore from "./store.js"

import type { CodeMode } from "@ocpp/codemode"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm"
import { SessionFact } from "@ocpp/schema/session-fact"
import { Context, Effect, Layer, type Schema } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { KeyedMutex } from "../effect/keyed-mutex.js"
import { Job } from "../job.js"
import type { SessionMessage } from "../session/message.js"
import type { SessionSchema } from "../session/schema.js"
import type { ToolLists } from "../tool/lists.js"
import { SessionMessageTable } from "../session/sql.js"
import type { CodeModeCompletion } from "../session/codemode-completion.js"
import { CodeModeChildren } from "./children.js"
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
  /** The tool list its catalog came from; absent for executions admitted before tool lists were stored. */
  readonly tools?: ToolLists.Selection
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
  /**
   * The child sessions an execution's journaled calls named, with each call's outcome; a call that
   * never settled is interrupted. Lets a notification written after a restart list them as the live
   * run would have. Empty once the execution is discarded.
   */
  readonly children: (executionID: string) => Effect.Effect<ReadonlyArray<CodeModeCompletion.Child>>
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

/**
 * Names saved in a Session's notebook, read inside the caller's transaction. Saved names are immutable
 * and only a committed revert removes them, so a set of names identifies a stable notebook checkpoint.
 */
export const savedNames = Effect.fnUntraced(function* (db: Database.Interface["db"], sessionID: SessionSchema.ID) {
  return (yield* db
    .select({ name: CodeModeBindingTable.name })
    .from(CodeModeBindingTable)
    .where(eq(CodeModeBindingTable.session_id, sessionID))
    .all()
    .pipe(Effect.orDie)).map((row) => row.name)
})

const RESTART_MESSAGE = "Execution became indeterminate because the host restarted before it settled."

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const bus = yield* Bus.Service
    const jobs = yield* Job.Service
    // Decisions that read a Session's notebook (admission, settling, resuming) are made one at a time.
    const locks = KeyedMutex.makeUnsafe<SessionSchema.ID>()

    // The notebook, its reservations and every execution's journal are projections of the executions'
    // facts in Specter's Event Log, written in the transaction that records each fact.
    yield* bus.project(SessionFact.ExecutionAdmitted, (event) =>
      Effect.gen(function* () {
        const data = event.data
        if (data.reserved.length > 0)
          yield* db
            .insert(CodeModeReservationTable)
            .values(
              data.reserved.map((name) => ({
                session_id: data.sessionID,
                name,
                execution_id: data.executionID,
                time_created: event.created,
              })),
            )
            .run()
        const program = data.program as unknown as CodeMode.Program
        yield* db
          .insert(CodeModeExecutionTable)
          .values({
            id: data.executionID,
            session_id: data.sessionID,
            assistant_message_id: data.assistantMessageID,
            tool_call_id: data.toolCallID,
            status: "scheduled",
            program,
            ir_version: program.version,
            snapshot: data.snapshot,
            ...(data.input === undefined ? {} : { input: data.input as CodeMode.DataValue }),
            ...(data.tools === undefined ? {} : { tools: data.tools as unknown as ToolLists.Selection }),
            time_created: event.created,
            time_updated: event.created,
          })
          .run()
      }).pipe(Effect.orDie),
    )
    yield* bus.project(SessionFact.ExecutionStarted, (event) =>
      db
        .update(CodeModeExecutionTable)
        .set({ status: "running", time_updated: event.created })
        .where(
          and(eq(CodeModeExecutionTable.id, event.data.executionID), eq(CodeModeExecutionTable.status, "scheduled")),
        )
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* bus.project(SessionFact.ExecutionResumed, (event) =>
      db
        .update(CodeModeExecutionTable)
        .set({ resumes: sql`${CodeModeExecutionTable.resumes} + 1`, time_updated: event.created })
        .where(and(eq(CodeModeExecutionTable.id, event.data.executionID), eq(CodeModeExecutionTable.status, "running")))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* bus.project(SessionFact.ExecutionSettled, (event) =>
      event.data.outcome === "finished"
        ? saveDeclarations(db, event.data, event.created)
        : abandon(db, event.data.executionID, event.data.outcome, event.data.error ?? RESTART_MESSAGE, event.created),
    )
    yield* bus.project(SessionFact.ExecutionDiscarded, (event) =>
      Effect.gen(function* () {
        yield* db
          .delete(CodeModeReservationTable)
          .where(eq(CodeModeReservationTable.execution_id, event.data.executionID))
          .run()
        yield* db
          .delete(CodeModeExecutionTable)
          .where(
            and(eq(CodeModeExecutionTable.id, event.data.executionID), eq(CodeModeExecutionTable.status, "scheduled")),
          )
          .run()
      }).pipe(Effect.orDie),
    )
    yield* bus.project(SessionFact.CallScheduled, (event) =>
      db
        .insert(CodeModeJournalTable)
        .values({
          execution_id: event.data.executionID,
          call_index: event.data.index,
          tool: event.data.tool,
          input: event.data.input,
          status: "scheduled",
          omitted: event.data.omitted,
          ...(event.data.impure === undefined ? {} : { impure: event.data.impure }),
          time_created: event.created,
          time_updated: event.created,
        })
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* bus.project(SessionFact.CallProgressed, (event) =>
      db
        .update(CodeModeJournalTable)
        .set({ progress: event.data.progress, time_updated: event.created })
        .where(
          and(
            eq(CodeModeJournalTable.execution_id, event.data.executionID),
            eq(CodeModeJournalTable.call_index, event.data.index),
          ),
        )
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* bus.project(SessionFact.CallSettled, (event) =>
      db
        .update(CodeModeJournalTable)
        .set({
          status: event.data.outcome,
          ...(event.data.output === undefined ? {} : { output: event.data.output }),
          error: event.data.error ?? null,
          ...(event.data.omitted ? { omitted: true } : {}),
          time_completed: event.created,
          time_updated: event.created,
        })
        // A call a shutdown interrupted is indeterminate until a resumed run settles it again.
        .where(
          and(
            eq(CodeModeJournalTable.execution_id, event.data.executionID),
            eq(CodeModeJournalTable.call_index, event.data.index),
            inArray(CodeModeJournalTable.status, ["scheduled", "indeterminate"]),
          ),
        )
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )

    const readBindings: Interface["bindings"] = Effect.fnUntraced(function* (sessionID) {
      return Object.fromEntries(
        (yield* db
          .select({ name: CodeModeBindingTable.name, value: CodeModeBindingTable.value })
          .from(CodeModeBindingTable)
          .where(eq(CodeModeBindingTable.session_id, sessionID))
          .orderBy(desc(CodeModeBindingTable.message_seq), asc(CodeModeBindingTable.name))
          .all()
          .pipe(Effect.orDie)).map((row) => [row.name, row.value]),
      )
    })

    const execution = (executionID: string) =>
      db
        .select({ sessionID: CodeModeExecutionTable.session_id, status: CodeModeExecutionTable.status })
        .from(CodeModeExecutionTable)
        .where(eq(CodeModeExecutionTable.id, executionID))
        .get()
        .pipe(Effect.orDie)
    // The Session each running execution belongs to, for its calls' facts.
    const sessions = new Map<string, SessionSchema.ID>()
    const sessionOf = (executionID: string) =>
      Effect.suspend(() => {
        const known = sessions.get(executionID)
        if (known) return Effect.succeed(known)
        return execution(executionID).pipe(
          Effect.map((row) => {
            if (row) sessions.set(executionID, row.sessionID)
            return row?.sessionID
          }),
        )
      })
    const journaled = (executionID: string, index: number) =>
      db
        .select({ status: CodeModeJournalTable.status })
        .from(CodeModeJournalTable)
        .where(and(eq(CodeModeJournalTable.execution_id, executionID), eq(CodeModeJournalTable.call_index, index)))
        .get()
        .pipe(Effect.orDie)

    // Names are verified and reserved under the Session's lock, so an execution only receives an ID once
    // every name it will save belongs to it alone.
    const admit: Interface["admit"] = Effect.fn("CodeModeStore.admit")((input) =>
      locks.withLock(input.sessionID)(
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
          const bindings = yield* db
            .select({ name: CodeModeBindingTable.name, value: CodeModeBindingTable.value })
            .from(CodeModeBindingTable)
            .where(eq(CodeModeBindingTable.session_id, input.sessionID))
            .orderBy(desc(CodeModeBindingTable.message_seq), asc(CodeModeBindingTable.name))
            .all()
            .pipe(Effect.orDie)
          const totals = yield* db
            .select(notebookTotals)
            .from(CodeModeBindingTable)
            .where(eq(CodeModeBindingTable.session_id, input.sessionID))
            .get()
            .pipe(Effect.orDie)
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
              : yield* db
                  .select({ name: CodeModeReservationTable.name, owner: CodeModeReservationTable.execution_id })
                  .from(CodeModeReservationTable)
                  .where(
                    and(
                      eq(CodeModeReservationTable.session_id, input.sessionID),
                      inArray(CodeModeReservationTable.name, names),
                    ),
                  )
                  .all()
                  .pipe(Effect.orDie)
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
          yield* bus.publish(SessionFact.ExecutionAdmitted, {
            sessionID: input.sessionID,
            executionID: input.id,
            assistantMessageID: input.assistantMessageID,
            toolCallID: input.toolCallID,
            program: json(input.program),
            ...(input.input === undefined ? {} : { input: json(input.input) }),
            ...(input.tools === undefined ? {} : { tools: json(input.tools) }),
            snapshot: bindings.map((binding) => binding.name),
            reserved: names,
          })
          sessions.set(input.id, input.sessionID)
          return {
            ok: true as const,
            execution: {
              ...input,
              bindings: Object.fromEntries(bindings.map((binding) => [binding.name, binding.value])),
            },
          }
        }),
      ),
    )

    const running: Interface["running"] = Effect.fn("CodeModeStore.running")(function* (executionID) {
      const row = yield* execution(executionID)
      if (row?.status !== "scheduled") return
      yield* bus.publish(SessionFact.ExecutionStarted, { sessionID: row.sessionID, executionID })
    })

    // A resumed run re-reaches calls that are already journaled, so the first record of a call wins.
    const scheduleCall: Interface["scheduleCall"] = Effect.fn("CodeModeStore.scheduleCall")(function* (input) {
      const sessionID = yield* sessionOf(input.executionID)
      if (!sessionID || (yield* journaled(input.executionID, input.index))) return
      const captured = boundedCapture(input.input)
      yield* bus.publish(SessionFact.CallScheduled, {
        sessionID,
        executionID: input.executionID,
        index: input.index,
        tool: input.tool,
        input: json(captured ?? "[input omitted: capture limit exceeded]"),
        omitted: captured === undefined,
        ...(input.impure === undefined || input.impure.length === 0 ? {} : { impure: input.impure }),
      })
    })

    const progressCall: Interface["progressCall"] = Effect.fn("CodeModeStore.progressCall")(function* (input) {
      const sessionID = yield* sessionOf(input.executionID)
      if (!sessionID || !(yield* journaled(input.executionID, input.index))) return
      yield* bus.publish(SessionFact.CallProgressed, {
        sessionID,
        executionID: input.executionID,
        index: input.index,
        progress: json(input.progress) as Readonly<Record<string, Schema.Json>>,
      })
    })

    const settleCall: Interface["settleCall"] = Effect.fn("CodeModeStore.settleCall")(function* (input) {
      const sessionID = yield* sessionOf(input.executionID)
      const entry = yield* journaled(input.executionID, input.index)
      if (!sessionID || (entry?.status !== "scheduled" && entry?.status !== "indeterminate")) return
      const output = input.output === undefined ? undefined : boundedCapture(input.output)
      // A completed call replays only from its exact result, so a result the journal could not hold
      // in full, or could not represent as JSON at all, marks the call as not replayable.
      const omitted =
        (input.outcome === "completed" && output === undefined) ||
        (input.error !== undefined && new TextEncoder().encode(input.error).byteLength > limits.maxCaptureBytes)
      yield* bus.publish(SessionFact.CallSettled, {
        sessionID,
        executionID: input.executionID,
        index: input.index,
        outcome: input.outcome,
        ...(input.output === undefined ? {} : { output: json(output ?? "[output omitted: capture limit exceeded]") }),
        ...(input.error === undefined ? {} : { error: truncate(input.error, limits.maxCaptureBytes) }),
        omitted,
      })
    })

    // The notebook decides whether the declarations save as it records them (saveDeclarations), so a
    // stale worker can never write into a reverted notebook.
    const commit: Interface["commit"] = Effect.fn("CodeModeStore.commit")((execution, declarations) =>
      locks.withLock(execution.sessionID)(
        Effect.gen(function* () {
          yield* bus.publish(SessionFact.ExecutionSettled, {
            sessionID: execution.sessionID,
            executionID: execution.id,
            outcome: "finished",
            values: json(declarations) as Readonly<Record<string, Schema.Json>>,
          })
          sessions.delete(execution.id)
          const row = yield* db
            .select({
              status: CodeModeExecutionTable.status,
              saved: CodeModeExecutionTable.saved,
              error: CodeModeExecutionTable.error,
            })
            .from(CodeModeExecutionTable)
            .where(eq(CodeModeExecutionTable.id, execution.id))
            .get()
            .pipe(Effect.orDie)
          return row?.status === "saved"
            ? { status: "saved" as const, saved: row.saved ?? [] }
            : {
                status: "failed" as const,
                saved: [],
                error: row?.error ?? "The execution was not found; nothing was saved.",
              }
        }),
      ),
    )

    const settle = (executionID: string, outcome: "failed" | "indeterminate", error: string) =>
      Effect.gen(function* () {
        const row = yield* execution(executionID)
        if (row?.status !== "scheduled" && row?.status !== "running") return
        yield* locks.withLock(row.sessionID)(
          bus.publish(SessionFact.ExecutionSettled, { sessionID: row.sessionID, executionID, outcome, error }),
        )
        sessions.delete(executionID)
      })

    const discard: Interface["discard"] = Effect.fn("CodeModeStore.discard")(function* (executionID) {
      const row = yield* execution(executionID)
      if (row?.status !== "scheduled") return
      yield* locks.withLock(row.sessionID)(
        bus.publish(SessionFact.ExecutionDiscarded, { sessionID: row.sessionID, executionID }),
      )
      sessions.delete(executionID)
    })

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
    // Session that admitted them and are never inherited. Runs as part of the fork's projection.
    const fork: Interface["fork"] = Effect.fn("CodeModeStore.fork")(function* (input) {
      const bindings = yield* db
        .select()
        .from(CodeModeBindingTable)
        .where(
          and(eq(CodeModeBindingTable.session_id, input.from), lte(CodeModeBindingTable.message_seq, input.throughSeq)),
        )
        .all()
        .pipe(Effect.orDie)
      if (bindings.length === 0) return
      yield* db
        .insert(CodeModeBindingTable)
        .values(bindings.map((binding) => ({ ...binding, session_id: input.to })))
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    })

    // Runs as part of a committed revert's projection.
    const revert: Interface["revert"] = Effect.fn("CodeModeStore.revert")(function* (input) {
      yield* db
        .delete(CodeModeBindingTable)
        .where(
          and(
            eq(CodeModeBindingTable.session_id, input.sessionID),
            gte(CodeModeBindingTable.message_seq, input.beforeSeq),
          ),
        )
        .run()
        .pipe(Effect.orDie)
      // An in-flight execution whose message was removed must not save, so release its names
      // now instead of leaving them held until it settles.
      yield* db
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
        .pipe(Effect.orDie)
    })

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

    const resume: Interface["resume"] = Effect.fn("CodeModeStore.resume")(function* (executionID) {
      const current = yield* execution(executionID)
      if (current?.status !== "running") return undefined
      return yield* locks.withLock(current.sessionID)(
        Effect.gen(function* () {
          yield* bus.publish(SessionFact.ExecutionResumed, { sessionID: current.sessionID, executionID })
          const row = yield* db
            .select()
            .from(CodeModeExecutionTable)
            .where(and(eq(CodeModeExecutionTable.id, executionID), eq(CodeModeExecutionTable.status, "running")))
            .get()
            .pipe(Effect.orDie)
          if (row === undefined) return undefined
          sessions.set(executionID, row.session_id)
          const bindings =
            row.snapshot.length === 0
              ? []
              : yield* db
                  .select({ name: CodeModeBindingTable.name, value: CodeModeBindingTable.value })
                  .from(CodeModeBindingTable)
                  .where(
                    and(
                      eq(CodeModeBindingTable.session_id, row.session_id),
                      inArray(CodeModeBindingTable.name, [...row.snapshot]),
                    ),
                  )
                  .orderBy(desc(CodeModeBindingTable.message_seq), asc(CodeModeBindingTable.name))
                  .all()
                  .pipe(Effect.orDie)
          const journal = yield* db
            .select()
            .from(CodeModeJournalTable)
            .where(eq(CodeModeJournalTable.execution_id, executionID))
            .orderBy(CodeModeJournalTable.call_index)
            .all()
            .pipe(Effect.orDie)
          return {
            execution: {
              id: row.id,
              sessionID: row.session_id,
              assistantMessageID: row.assistant_message_id,
              toolCallID: row.tool_call_id,
              program: row.program,
              ...(row.input === null ? {} : { input: row.input }),
              ...(row.tools === null ? {} : { tools: row.tools }),
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
    })

    const children: Interface["children"] = Effect.fn("CodeModeStore.children")((executionID) =>
      db
        .select({
          status: CodeModeJournalTable.status,
          output: CodeModeJournalTable.output,
          progress: CodeModeJournalTable.progress,
        })
        .from(CodeModeJournalTable)
        .where(eq(CodeModeJournalTable.execution_id, executionID))
        .orderBy(CodeModeJournalTable.call_index)
        .all()
        .pipe(Effect.orDie, Effect.map(CodeModeChildren.fromJournal)),
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
      children,
      get,
      bindings: readBindings,
      reservations,
      fork,
      revert,
    })
  }),
)

// Saves a finished execution's declarations when it still holds every reserved name, the message that
// started it was not reverted, and they fit the notebook; otherwise it fails, saving nothing. Concurrent
// executions both pass admission and only meet here, in the transaction that records the fact.
const saveDeclarations = (
  db: Database.Interface["db"],
  data: {
    readonly sessionID: SessionSchema.ID
    readonly executionID: string
    readonly values?: Readonly<Record<string, Schema.Json>>
  },
  time: number,
) =>
  Effect.gen(function* () {
    const declarations = (data.values ?? {}) as Readonly<Record<string, CodeMode.NotebookValue>>
    const names = Object.keys(declarations)
    const held = yield* db
      .select({ name: CodeModeReservationTable.name })
      .from(CodeModeReservationTable)
      .where(eq(CodeModeReservationTable.execution_id, data.executionID))
      .all()
    const owned = new Set(held.map((row) => row.name))
    const lost = names.filter((name) => !owned.has(name))
    const started = yield* db
      .select({ messageID: CodeModeExecutionTable.assistant_message_id })
      .from(CodeModeExecutionTable)
      .where(eq(CodeModeExecutionTable.id, data.executionID))
      .get()
    const message =
      lost.length > 0 || !started
        ? undefined
        : yield* db
            .select({ seq: SessionMessageTable.seq })
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, data.sessionID), eq(SessionMessageTable.id, started.messageID)),
            )
            .get()
    const totals = yield* db
      .select(notebookTotals)
      .from(CodeModeBindingTable)
      .where(eq(CodeModeBindingTable.session_id, data.sessionID))
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
    yield* db.delete(CodeModeReservationTable).where(eq(CodeModeReservationTable.execution_id, data.executionID)).run()
    if (error === undefined && names.length > 0)
      yield* db
        .insert(CodeModeBindingTable)
        .values(
          names.map((name) => ({
            session_id: data.sessionID,
            name,
            value: declarations[name],
            message_seq: message?.seq ?? 0,
            execution_id: data.executionID,
          })),
        )
        .run()
    yield* db
      .update(CodeModeExecutionTable)
      .set({
        status: error === undefined ? "saved" : "failed",
        saved: error === undefined ? names : [],
        ...(error === undefined ? {} : { error }),
        time_completed: time,
        time_updated: time,
      })
      .where(eq(CodeModeExecutionTable.id, data.executionID))
      .run()
  }).pipe(Effect.orDie)

// Ends an execution that did not finish: its names are released, its scheduled calls become
// indeterminate, and it settles unless it already has.
const abandon = (
  db: Database.Interface["db"],
  executionID: string,
  status: Extract<Status, "failed" | "indeterminate">,
  error: string,
  time: number,
) =>
  Effect.gen(function* () {
    yield* db.delete(CodeModeReservationTable).where(eq(CodeModeReservationTable.execution_id, executionID)).run()
    yield* db
      .update(CodeModeJournalTable)
      .set({ status: "indeterminate", error, time_completed: time, time_updated: time })
      .where(and(eq(CodeModeJournalTable.execution_id, executionID), eq(CodeModeJournalTable.status, "scheduled")))
      .run()
    yield* db
      .update(CodeModeExecutionTable)
      .set({ status, saved: [], error, time_completed: time, time_updated: time })
      .where(
        and(
          eq(CodeModeExecutionTable.id, executionID),
          sql`${CodeModeExecutionTable.status} in ('scheduled', 'running')`,
        ),
      )
      .run()
  }).pipe(Effect.orDie)

/** JSON as it is stored: what a fact carries of a value. */
const json = (value: unknown) => JSON.parse(JSON.stringify(value ?? null)) as Schema.Json

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

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node, Job.node] })
