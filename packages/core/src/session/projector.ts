export * as SessionProjector from "./projector.js"

import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm"
import { DateTime, Effect, Layer, Schema, Stream } from "effect"
import path from "path"
import { Database } from "../database/database.js"
import { Bus } from "../bus.js"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { Agent } from "@ocpp/schema/agent"
import { Model } from "@ocpp/schema/model"
import { SessionEvent } from "./event.js"
import { SessionMessage } from "./message.js"
import { SessionMessageUpdater } from "./message-updater.js"
import { SessionInbox } from "./inbox.js"
import { Workspace } from "@ocpp/schema/workspace"
import { InstructionState } from "./instruction-state.js"
import { InstructionEntryTable, SessionInboxTable, SessionMessageTable, SessionTable } from "./sql.js"
import type { InstructionEntry } from "@ocpp/schema/instruction-entry"
import { SessionFact } from "@ocpp/schema/session-fact"
import { Slug } from "../util/slug.js"
import { FSUtil } from "@ocpp/util/fs-util"
import { Money } from "@ocpp/schema/money"
import { Worktree } from "@ocpp/schema/worktree"
import { Project } from "@ocpp/schema/project"
import { AbsolutePath, RelativePath } from "../schema.js"
import type { SessionSchema } from "./schema.js"
import { ProjectTable } from "../project/sql.js"
import { CodeModeHandler } from "../codemode/handler.js"
import { CodeModeStore } from "../codemode/store.js"

type DatabaseService = Database.Interface["db"]
type MessageEvent = Exclude<
  SessionEvent.DurableEvent,
  typeof SessionEvent.Forked.Type | typeof SessionEvent.Deleted.Type
>

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Info)
const encodeMessage = Schema.encodeSync(SessionMessage.Info)

export class SessionAlreadyProjected extends Error {}

type Usage = {
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cache: { read: number; write: number }
  }
}

const ForkBatchSize = 500

const forkTitle = (value?: string) => {
  if (value === undefined) return
  const match = value.match(/^(.+) \(fork #(\d+)\)$/)
  if (match) return `${match[1]} (fork #${Number.parseInt(match[2], 10) + 1})`
  return `${value} (fork #1)`
}

function applyUsage(db: DatabaseService, sessionID: SessionSchema.ID, value: Usage) {
  return db
    .update(SessionTable)
    .set({
      cost: sql`${SessionTable.cost} + ${value.cost}`,
      tokens_input: sql`${SessionTable.tokens_input} + ${value.tokens.input}`,
      tokens_output: sql`${SessionTable.tokens_output} + ${value.tokens.output}`,
      tokens_reasoning: sql`${SessionTable.tokens_reasoning} + ${value.tokens.reasoning}`,
      tokens_cache_read: sql`${SessionTable.tokens_cache_read} + ${value.tokens.cache.read}`,
      tokens_cache_write: sql`${SessionTable.tokens_cache_write} + ${value.tokens.cache.write}`,
      time_updated: sql`${SessionTable.time_updated}`,
    })
    .where(eq(SessionTable.id, sessionID))
    .run()
    .pipe(Effect.orDie)
}

const publishSessionUsage = Effect.fn("SessionProjector.publishUsage")(function* (
  db: DatabaseService,
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({
      cost: SessionTable.cost,
      input: SessionTable.tokens_input,
      output: SessionTable.tokens_output,
      reasoning: SessionTable.tokens_reasoning,
      cacheRead: SessionTable.tokens_cache_read,
      cacheWrite: SessionTable.tokens_cache_write,
    })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!row) return
  yield* bus.publish(SessionEvent.UsageUpdated, {
    sessionID,
    cost: Money.USD.make(row.cost),
    tokens: {
      input: row.input,
      output: row.output,
      reasoning: row.reasoning,
      cache: { read: row.cacheRead, write: row.cacheWrite },
    },
  })
})

const projectFork = Effect.fn("SessionProjector.projectFork")(function* (
  db: DatabaseService,
  codemode: CodeModeStore.Interface,
  event: typeof SessionEvent.Forked.Type,
) {
  const parent = yield* db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.id, event.data.parentID))
    .get()
    .pipe(Effect.orDie)
  if (!parent) return yield* Effect.die(new Error(`Fork parent session not found: ${event.data.parentID}`))
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, event.data.parentID),
        eq(SessionMessageTable.id, event.data.boundary.messageID),
      ),
    )
    .get()
    .pipe(Effect.orDie)
  if (!boundary)
    return yield* Effect.die(new Error(`Fork boundary message not found: ${event.data.boundary.messageID}`))
  const copied = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, event.data.parentID),
        event.data.boundary.type === "before"
          ? lt(SessionMessageTable.seq, boundary.seq)
          : lte(SessionMessageTable.seq, boundary.seq),
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  const copiedSeq = copied?.seq

  const stored = yield* db
    .insert(SessionTable)
    .values({
      id: event.data.sessionID,
      parent_id: null,
      fork_session_id: event.data.parentID,
      fork_boundary: event.data.boundary,
      project_id: parent.project_id,
      workspace_id: parent.workspace_id,
      slug: Slug.create(),
      directory: parent.directory,
      path: parent.path,
      title: forkTitle(parent.title ?? undefined),
      agent: parent.agent,
      // A fork keeps its parent's stored tool list, so a fork of a subagent keeps the tools it was given.
      tools: parent.tools,
      model: parent.model,
      metadata: parent.metadata,
      version: parent.version,
      cost: 0,
      tokens_input: 0,
      tokens_output: 0,
      tokens_reasoning: 0,
      tokens_cache_read: 0,
      tokens_cache_write: 0,
      time_created: event.created,
      time_updated: event.created,
    })
    .onConflictDoNothing()
    .returning({ sessionID: SessionTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die(new SessionAlreadyProjected())

  if (event.data.instructionEntries)
    yield* initializeInstructionEntries(db, event.data.sessionID, event.data.instructionEntries, event.created)

  let cursor = -1
  while (copiedSeq !== undefined) {
    const rows = yield* db
      .select()
      .from(SessionMessageTable)
      .where(
        and(
          eq(SessionMessageTable.session_id, event.data.parentID),
          gt(SessionMessageTable.seq, cursor),
          lt(SessionMessageTable.seq, copiedSeq + 1),
          // Terminal events for active projections stay on the parent, so forks copy only settled history.
          sql`${SessionMessageTable.type} != 'assistant' or json_extract(${SessionMessageTable.data}, '$.time.completed') is not null`,
          sql`${SessionMessageTable.type} != 'shell' or json_extract(${SessionMessageTable.data}, '$.status') != 'running'`,
          sql`${SessionMessageTable.type} != 'compaction' or json_extract(${SessionMessageTable.data}, '$.status') != 'running'`,
          sql`${SessionMessageTable.type} != 'invocation' or json_extract(${SessionMessageTable.data}, '$.status') != 'running'`,
        ),
      )
      .orderBy(asc(SessionMessageTable.seq))
      .limit(ForkBatchSize)
      .all()
      .pipe(Effect.orDie)
    if (rows.length === 0) break

    yield* db
      .insert(SessionMessageTable)
      .values(
        rows.map((row) => ({
          id: SessionMessage.ID.make(`${SessionMessage.ID.fromEvent(event.id)}_${row.seq}`),
          session_id: event.data.sessionID,
          type: row.type,
          seq: row.seq,
          time_created: row.time_created,
          time_updated: row.time_updated,
          data: row.type === "assistant" ? settledCodeMode(row) : row.data,
        })),
      )
      .run()
      .pipe(Effect.orDie)

    cursor = rows.at(-1)!.seq
  }
  if (copiedSeq !== undefined) yield* Bus.reserveSequence(db, event.data.sessionID, copiedSeq)
  yield* codemode.fork({
    from: event.data.parentID,
    to: event.data.sessionID,
    throughSeq: copiedSeq ?? -1,
  })
  yield* CodeModeHandler.fork(db, { from: event.data.parentID, to: event.data.sessionID })
  if (event.data.instructions)
    yield* InstructionState.initialize(db, event.data.sessionID, event.durable.seq, event.data.instructions)
})

/**
 * An execution belongs to the Session that admitted it: its completion notification and the notebook
 * values it saves stay on the parent. A fork copies the settled tool result that announced it, so
 * that result is rewritten here to stop promising a notification the child will never receive. This
 * mirrors how running shell and compaction messages are left behind entirely.
 */
function settledCodeMode(row: typeof SessionMessageTable.$inferSelect) {
  const message = decodeMessage({ ...row.data, id: row.id, type: row.type })
  if (message.type !== "assistant") return row.data
  const inflight = message.content.some(
    (part) => part.type === "tool" && part.state.status !== "streaming" && running(part.state.metadata),
  )
  if (!inflight) return row.data
  const { id, type, ...data } = encodeMessage({
    ...message,
    content: message.content.map((part) => {
      if (part.type !== "tool" || part.state.status === "streaming" || !running(part.state.metadata)) return part
      const metadata = part.state.metadata ?? {}
      const executionID = metadata.executionID
      return {
        ...part,
        state: {
          ...part.state,
          status: "completed" as const,
          content: [
            {
              type: "text" as const,
              text:
                "Execution " +
                (typeof executionID === "string" ? executionID : "") +
                " was still running when this Session was forked. It stayed with the original Session: no notification arrives here and it saves no notebook values here. Start a new execution if you still need its result.",
            },
          ],
          metadata: { ...metadata, executionStatus: "cancelled" },
        },
      }
    }),
  })
  return data
}

const running = (metadata: Record<string, Schema.Json> | undefined) => metadata?.executionStatus === "running"

function run(db: DatabaseService, event: MessageEvent) {
  return Effect.gen(function* () {
    const decodeRow = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type })
    const updateMessage = (message: SessionMessage.Info) => {
      const encoded = encodeMessage(message)
      const { id, type, ...data } = encoded
      return db
        .update(SessionMessageTable)
        .set({ type, time_created: DateTime.toEpochMillis(message.time.created), time_updated: event.created, data })
        .where(
          and(
            eq(SessionMessageTable.id, SessionMessage.ID.make(id)),
            eq(SessionMessageTable.session_id, event.data.sessionID),
          ),
        )
        .run()
        .pipe(Effect.orDie)
    }
    const appendMessage = (message: SessionMessage.Info) => insertMessage(db, event, message)
    const adapter: SessionMessageUpdater.Adapter = {
      getAgent() {
        return db
          .select({ agent: SessionTable.agent })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => (row?.agent ? Agent.ID.make(row.agent) : undefined)),
          )
      },
      getModel() {
        return db
          .select({ model: SessionTable.model })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) => (row?.model ? Schema.decodeUnknownSync(Model.Ref)(row.model) : undefined)),
          )
      },
      getLocation() {
        return db
          .select({
            directory: SessionTable.directory,
            workspaceID: SessionTable.workspace_id,
            projectID: SessionTable.project_id,
            subpath: SessionTable.path,
          })
          .from(SessionTable)
          .where(eq(SessionTable.id, event.data.sessionID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) =>
              row
                ? {
                    location: {
                      directory: AbsolutePath.make(row.directory),
                      workspaceID: row.workspaceID ? Workspace.ID.make(row.workspaceID) : undefined,
                    },
                    projectID: row.projectID,
                    subpath: row.subpath === null ? undefined : RelativePath.make(row.subpath),
                  }
                : undefined,
            ),
          )
      },
      getCurrentAssistant() {
        return Effect.gen(function* () {
          // A newer step supersedes stale incomplete rows; never resume an older assistant projection.
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.type, "assistant")),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" && !message.time.completed ? message : undefined
        })
      },
      getAssistant(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "assistant"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "assistant" ? message : undefined
        })
      },
      getShell(shellID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "shell"),
                sql`json_extract(${SessionMessageTable.data}, '$.shellID') = ${shellID}`,
              ),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "shell" ? message : undefined
        })
      },
      getCompaction() {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "compaction"),
                sql`json_extract(${SessionMessageTable.data}, '$.status') = 'running'`,
              ),
            )
            .orderBy(desc(SessionMessageTable.seq))
            .limit(1)
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "compaction" ? message : undefined
        })
      },
      getInvocation(messageID) {
        return Effect.gen(function* () {
          const row = yield* db
            .select()
            .from(SessionMessageTable)
            .where(
              and(
                eq(SessionMessageTable.id, messageID),
                eq(SessionMessageTable.session_id, event.data.sessionID),
                eq(SessionMessageTable.type, "invocation"),
              ),
            )
            .get()
            .pipe(Effect.orDie)
          if (!row) return
          const message = decodeRow(row)
          return message.type === "invocation" ? message : undefined
        })
      },
      updateAssistant: updateMessage,
      updateShell: updateMessage,
      updateCompaction: updateMessage,
      updateInvocation: updateMessage,
      appendMessage,
    }
    yield* SessionMessageUpdater.update(adapter, event)
  })
}

function insertMessage(db: DatabaseService, event: SessionEvent.DurableEvent, message: SessionMessage.Info) {
  const encoded = encodeMessage(message)
  const { id, type, ...data } = encoded
  return db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(id),
      session_id: event.data.sessionID,
      type,
      seq: event.durable.seq,
      time_created: DateTime.toEpochMillis(message.time.created),
      time_updated: event.created,
      data,
    })
    .run()
    .pipe(Effect.orDie)
}

function projectIdle(
  db: DatabaseService,
  event:
    | typeof SessionEvent.Execution.Succeeded.Type
    | typeof SessionEvent.Execution.Failed.Type
    | typeof SessionEvent.Execution.Interrupted.Type,
) {
  return Effect.gen(function* () {
    yield* run(db, event)
    if (event.type === SessionEvent.Execution.Interrupted.type && event.data.reason === "shutdown") return
    const time = event.created
    const outcome =
      event.type === SessionEvent.Execution.Succeeded.type
        ? "succeeded"
        : event.type === SessionEvent.Execution.Failed.type
          ? "failed"
          : "interrupted"
    yield* db
      .update(SessionTable)
      .set({
        // Unread uses a strict timestamp comparison, so every terminal must advance even within one millisecond.
        time_idle: sql`max(${time}, coalesce(${SessionTable.time_idle} + 1, ${time}))`,
        idle_outcome: outcome,
        // Only a failure carries an error; the other terminals clear the previous one so the row
        // always describes the outcome recorded at time_idle.
        idle_error_type: event.type === SessionEvent.Execution.Failed.type ? event.data.error.type : null,
        idle_error_message: event.type === SessionEvent.Execution.Failed.type ? event.data.error.message : null,
        time_updated: sql`${SessionTable.time_updated}`,
      })
      .where(eq(SessionTable.id, event.data.sessionID))
      .run()
      .pipe(Effect.orDie)
  })
}

const InsertBatchSize = 10

// A fork starts with its parent's instruction entries, removed ones included.
const initializeInstructionEntries = Effect.fnUntraced(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  entries: InstructionEntry.Snapshot,
  created: number,
) {
  const batches = Array.from({ length: Math.ceil(entries.length / InsertBatchSize) }, (_, index) =>
    entries.slice(index * InsertBatchSize, (index + 1) * InsertBatchSize),
  )
  yield* Effect.forEach(
    batches,
    (batch) =>
      db
        .insert(InstructionEntryTable)
        .values(
          batch.map((entry) => ({
            ...entry,
            session_id: sessionID,
            time_created: created,
            time_updated: created,
          })),
        )
        .run()
        .pipe(Effect.orDie),
    { discard: true },
  )
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const db = (yield* Database.Service).db
    const codemode = yield* CodeModeStore.Service
    yield* bus.project(SessionFact.InstructionBlobsStored, (event) => InstructionState.storeBlobs(db, event.data.blobs))
    yield* bus.project(SessionFact.Imported, (event) =>
      Effect.gen(function* () {
        const data = event.data
        if (data.messages.length > 0) {
          yield* db
            .insert(SessionMessageTable)
            .values(
              data.messages.map((message) => ({
                id: message.id,
                session_id: data.sessionID,
                type: message.type,
                seq: message.seq,
                time_created: message.created,
                data: message.data,
              })) as never,
            )
            .run()
            .pipe(Effect.orDie)
          // The imported messages hold the Session's first sequence numbers, after its creation's.
          yield* Bus.reserveSequence(db, data.sessionID, event.durable.seq - 1 + data.messages.length)
        }
        yield* db
          .update(SessionTable)
          .set({
            cost: data.cost,
            tokens_input: data.tokens.input,
            tokens_output: data.tokens.output,
            tokens_reasoning: data.tokens.reasoning,
            tokens_cache_read: data.tokens.cacheRead,
            tokens_cache_write: data.tokens.cacheWrite,
            time_created: data.time.created,
            time_updated: data.time.updated,
            time_idle: data.time.idle ?? null,
            time_viewed: data.time.viewed ?? null,
            idle_outcome: data.outcome ?? null,
            time_archived: data.time.archived ?? null,
          })
          .where(eq(SessionTable.id, data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* bus.project(SessionFact.InstructionEntrySet, (event) =>
      db
        .insert(InstructionEntryTable)
        .values({
          session_id: event.data.sessionID,
          key: event.data.key,
          value: event.data.value,
          removed: false,
          time_created: event.created,
          time_updated: event.created,
        })
        .onConflictDoUpdate({
          target: [InstructionEntryTable.session_id, InstructionEntryTable.key],
          set: { value: event.data.value, removed: false, time_updated: event.created },
        })
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* bus.project(SessionFact.InstructionEntryRemoved, (event) =>
      db
        .update(InstructionEntryTable)
        .set({ value: null, removed: true, time_updated: event.created })
        .where(
          and(
            eq(InstructionEntryTable.session_id, event.data.sessionID),
            eq(InstructionEntryTable.key, event.data.key),
          ),
        )
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* bus.project(SessionEvent.Created, (event) =>
      Effect.gen(function* () {
        const stored = yield* db
          .insert(SessionTable)
          .values({
            id: event.data.sessionID,
            project_id: event.data.projectID,
            workspace_id: event.data.location.workspaceID ? Workspace.ID.make(event.data.location.workspaceID) : null,
            parent_id: event.data.parentID,
            slug: event.data.slug,
            directory: event.data.location.directory,
            path: event.data.subpath,
            title: event.data.title,
            agent: event.data.agent,
            model: event.data.model,
            metadata: event.data.metadata,
            version: event.data.version,
            time_created: event.created,
            time_updated: event.created,
          })
          .onConflictDoNothing()
          .returning({ sessionID: SessionTable.id })
          .get()
          .pipe(Effect.orDie)
        if (!stored) return yield* Effect.die(new SessionAlreadyProjected())
      }),
    )
    yield* bus.project(SessionEvent.Moved, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* db
          .update(SessionTable)
          .set({
            directory: event.data.location.directory,
            path: event.data.subpath,
            ...(event.data.projectID ? { project_id: event.data.projectID } : {}),
            workspace_id: event.data.location.workspaceID ? Workspace.ID.make(event.data.location.workspaceID) : null,
            time_updated: event.created,
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    // Sessions whose ownership came from the directory's previous resolution
    // follow its new identity. Location, transcript, instructions, and recency
    // are untouched: the session did not move, its directory got identified.
    yield* bus.project(Worktree.Event.Resolved, (event) =>
      Effect.gen(function* () {
        const candidates = [
          ...new Set(
            [event.data.previous, Project.ID.global, ...(event.data.adopted ?? [])].filter(
              (id) => id !== event.data.projectID,
            ),
          ),
        ]
        if (candidates.length === 0) return
        const rows = yield* db
          .select({
            id: SessionTable.id,
            directory: SessionTable.directory,
            projectID: SessionTable.project_id,
            canonical: ProjectTable.worktree,
          })
          .from(SessionTable)
          .innerJoin(ProjectTable, eq(SessionTable.project_id, ProjectTable.id))
          .where(
            and(
              inArray(SessionTable.project_id, candidates),
              isNull(SessionTable.workspace_id),
              or(
                event.data.adopted?.length ? inArray(SessionTable.project_id, event.data.adopted) : undefined,
                and(
                  gte(SessionTable.directory, event.data.directory),
                  lte(SessionTable.directory, AbsolutePath.make(event.data.directory + "\uffff")),
                ),
              ),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        yield* Effect.forEach(
          rows,
          (row) => {
            const directory = event.data.adopted?.includes(row.projectID)
              ? row.canonical
              : AbsolutePath.make(path.resolve(row.directory))
            if (!FSUtil.contains(event.data.directory, directory)) return Effect.void
            return db
              .update(SessionTable)
              .set({
                project_id: event.data.projectID,
                path: RelativePath.make(path.relative(event.data.directory, directory).replaceAll("\\", "/")),
                // Self-assignment suppresses the column's $onUpdate: adoption is not activity.
                time_updated: sql`${SessionTable.time_updated}`,
              })
              .where(eq(SessionTable.id, row.id))
              .run()
              .pipe(Effect.orDie)
          },
          { discard: true },
        )
      }),
    )
    yield* bus.project(SessionEvent.Deleted, (event) =>
      db.delete(SessionTable).where(eq(SessionTable.id, event.data.sessionID)).run().pipe(Effect.orDie),
    )
    yield* bus.project(SessionEvent.AgentSelected, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* db
          .update(SessionTable)
          .set({ agent: event.data.agent, time_updated: event.created })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* bus.project(SessionEvent.ToolsSelected, (event) =>
      db
        .update(SessionTable)
        .set({ tools: event.data.tools, time_updated: event.created })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* bus.project(SessionEvent.ModelSelected, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* db
          .update(SessionTable)
          .set({ model: event.data.model, time_updated: event.created })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* bus.project(SessionEvent.Renamed, (event) =>
      db
        .update(SessionTable)
        .set({ title: event.data.title, time_updated: event.created })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    yield* bus.project(SessionEvent.Viewed, (event) => {
      const idle = event.data.idle
      return db
        .update(SessionTable)
        .set({
          // Monotone watermark: a duplicate or stale view never regresses, and a terminal event
          // committing after the viewer's observation keeps the newer idle transition unread.
          time_viewed: sql`max(${idle}, coalesce(${SessionTable.time_viewed}, ${idle}))`,
          time_updated: sql`${SessionTable.time_updated}`,
        })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie)
    })
    yield* bus.project(SessionEvent.MessageContentUpdated, (event) => run(db, event))
    yield* bus.project(SessionEvent.UsageRecorded, (event) => applyUsage(db, event.data.sessionID, event.data))
    yield* bus.project(SessionEvent.Forked, (event) => projectFork(db, codemode, event))
    yield* bus.project(SessionEvent.InboxDelivered, (event) =>
      Effect.gen(function* () {
        const input = yield* SessionInbox.projectDelivered(db, {
          id: event.data.inboxID,
          sessionID: event.data.sessionID,
        })
        if (input.type === "compaction" || input.type === "move") return
        yield* insertMessage(
          db,
          event,
          input.type === "user"
            ? {
                id: input.id,
                type: "user",
                metadata: input.payload.metadata,
                text: input.payload.text,
                files: input.payload.files,
                agents: input.payload.agents,
                skills: input.payload.skills,
                time: { created: DateTime.makeUnsafe(event.created) },
              }
            : {
                id: input.id,
                type: "synthetic",
                text: input.payload.text,
                description: input.payload.description,
                files: input.payload.files,
                metadata: input.payload.metadata,
                time: { created: DateTime.makeUnsafe(event.created) },
              },
        )
      }),
    )
    yield* bus.project(SessionEvent.InboxEnqueued, (event) =>
      Effect.gen(function* () {
        yield* SessionInbox.projectAdmitted(db, {
          enqueuedSeq: event.durable.seq,
          id: event.data.inboxID,
          sessionID: event.data.sessionID,
          item: event.data.item,
          timeCreated: event.created,
        })
        yield* db
          .update(SessionTable)
          .set({ time_updated: event.created })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* bus.project(SessionEvent.InboxCancelled, (event) =>
      SessionInbox.projectCancelled(db, {
        id: event.data.inboxID,
        sessionID: event.data.sessionID,
      }),
    )
    yield* bus.project(SessionEvent.InboxDeliveryChanged, (event) =>
      SessionInbox.projectDeliveryChanged(db, {
        id: event.data.inboxID,
        sessionID: event.data.sessionID,
        delivery: event.data.delivery,
      }),
    )
    yield* bus.project(SessionEvent.Execution.Succeeded, (event) => projectIdle(db, event))
    yield* bus.project(SessionEvent.Execution.Failed, (event) => projectIdle(db, event))
    yield* bus.project(SessionEvent.Execution.Interrupted, (event) => projectIdle(db, event))
    yield* bus.project(SessionEvent.InstructionsUpdated, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* InstructionState.apply(db, event.data.sessionID, event.durable.seq, event.data.delta)
      }),
    )
    yield* bus.project(SessionEvent.Synthetic, (event) => run(db, event))
    yield* bus.project(SessionEvent.Displayed, (event) => run(db, event))
    yield* bus.project(SessionEvent.Skill.Activated, (event) => run(db, event))
    yield* bus.project(SessionEvent.Shell.Started, (event) => run(db, event))
    yield* bus.project(SessionEvent.Shell.Ended, (event) => run(db, event))
    yield* bus.project(SessionEvent.Step.Started, (event) => run(db, event))
    yield* bus.project(SessionEvent.Step.Streamed, (event) => run(db, event))
    yield* bus.project(SessionEvent.Step.Ended, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* applyUsage(db, event.data.sessionID, event.data)
      }),
    )
    yield* bus.project(SessionEvent.Step.Failed, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        if (event.data.cost !== undefined && event.data.tokens !== undefined)
          yield* applyUsage(db, event.data.sessionID, { cost: event.data.cost, tokens: event.data.tokens })
      }),
    )
    yield* bus.project(SessionEvent.Text.Started, (event) => run(db, event))
    yield* bus.project(SessionEvent.Text.Ended, (event) => run(db, event))
    yield* bus.project(SessionEvent.Tool.Input.Started, (event) => run(db, event))
    yield* bus.project(SessionEvent.Tool.Input.Ended, (event) => run(db, event))
    yield* bus.project(SessionEvent.Tool.Called, (event) => run(db, event))
    yield* bus.project(SessionEvent.Tool.Success, (event) => run(db, event))
    yield* bus.project(SessionEvent.Tool.Failed, (event) => run(db, event))
    yield* bus.project(SessionEvent.CodeMode.Started, (event) => run(db, event))
    yield* bus.project(SessionEvent.CodeMode.Completed, (event) => run(db, event))
    yield* bus.project(SessionEvent.CodeMode.Failed, (event) => run(db, event))
    yield* bus.project(SessionEvent.Invocation.Started, (event) => run(db, event))
    yield* bus.project(SessionEvent.Reasoning.Started, (event) => run(db, event))
    yield* bus.project(SessionEvent.Reasoning.Ended, (event) => run(db, event))
    yield* bus.project(SessionEvent.RetryScheduled, (event) => run(db, event))
    yield* bus.project(SessionEvent.Compaction.Started, (event) => run(db, event))
    yield* bus.project(SessionEvent.Compaction.Ended, (event) =>
      Effect.gen(function* () {
        yield* run(db, event)
        yield* InstructionState.advanceEpoch(db, event.data.sessionID, event.durable.seq)
      }),
    )
    yield* bus.project(SessionEvent.Compaction.Failed, (event) => run(db, event))
    yield* bus.project(SessionEvent.RevertEvent.Staged, (event) =>
      Effect.gen(function* () {
        const revert = event.data.revert
        yield* db
          .update(SessionTable)
          .set({
            revert: { ...revert, files: revert.files ? [...revert.files] : undefined },
            time_updated: event.created,
          })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* bus.project(SessionEvent.RevertEvent.Cleared, (event) =>
      db
        .update(SessionTable)
        .set({ revert: null, time_updated: event.created })
        .where(eq(SessionTable.id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* bus.project(SessionEvent.RevertEvent.Committed, (event) =>
      Effect.gen(function* () {
        const boundary = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), eq(SessionMessageTable.id, event.data.to)),
          )
          .get()
          .pipe(Effect.orDie)
        if (!boundary) return yield* Effect.die(new Error(`Revert boundary message not found: ${event.data.to}`))
        yield* db
          .delete(SessionMessageTable)
          .where(
            and(eq(SessionMessageTable.session_id, event.data.sessionID), gte(SessionMessageTable.seq, boundary.seq)),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .delete(SessionInboxTable)
          .where(
            and(
              eq(SessionInboxTable.session_id, event.data.sessionID),
              gte(SessionInboxTable.enqueued_seq, boundary.seq),
            ),
          )
          .run()
          .pipe(Effect.orDie)
        yield* db
          .update(SessionTable)
          .set({ revert: null, time_updated: event.created })
          .where(eq(SessionTable.id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
        yield* codemode.revert({ sessionID: event.data.sessionID, beforeSeq: boundary.seq })
        yield* CodeModeHandler.prune(db, event.data.sessionID)
        yield* InstructionState.reset(db, event.data.sessionID)
      }),
    )
    yield* bus.subscribe([SessionEvent.Step.Ended, SessionEvent.Step.Failed, SessionEvent.UsageRecorded]).pipe(
      Stream.runForEach((event) => {
        if (
          event.type === SessionEvent.Step.Failed.type &&
          (event.data.cost === undefined || event.data.tokens === undefined)
        )
          return Effect.void
        return publishSessionUsage(db, bus, event.data.sessionID)
      }),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
)

export const node = makeGlobalNode({
  name: "session-projector",
  layer,
  deps: [Bus.node, Database.node, CodeModeStore.node],
})
