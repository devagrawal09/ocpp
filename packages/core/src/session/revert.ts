export * as SessionRevert from "./revert.js"

import { and, asc, eq, gt, gte, inArray } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database.js"
import { Bus } from "../bus.js"
import { CodeModeBindingTable, CodeModeExecutionTable } from "../codemode/sql.js"
import { PluginSupervisor } from "../plugin/supervisor-service.js"
import { RelativePath } from "../schema.js"
import { Snapshot } from "../snapshot.js"
import { SpecterRejection } from "../specter/rejection.js"
import { BusyError, MessageNotFoundError, NotFoundError } from "./error.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionMessageTable } from "./sql.js"

export { MessageNotFoundError }

const encodeRevert = Schema.encodeSync(SessionSchema.Revert)

/**
 * The public error for a revert Command's rejection: the Session is gone, or runs (a revert changes only
 * an idle Session). `no-revert-staged` answers as if done.
 */
const refused =
  (sessionID: SessionSchema.ID) =>
  (error: unknown): Effect.Effect<void, BusyError | NotFoundError> => {
    const code = SpecterRejection.code(error)
    if (code === "no-revert-staged") return Effect.void
    if (code === "session-busy") return Effect.fail(new BusyError({ sessionID }))
    if (SpecterRejection.isMissingSession(error)) return Effect.fail(new NotFoundError({ sessionID }))
    return Effect.die(error)
  }

interface BoundaryInput {
  readonly sessionID: SessionSchema.ID
  readonly messageID: SessionMessage.ID
}

export interface Interface {
  readonly stage: (input: {
    readonly session: SessionSchema.Info
    readonly messageID: SessionMessage.ID
    readonly files?: boolean
  }) => Effect.Effect<SessionSchema.Revert, MessageNotFoundError | BusyError | NotFoundError | Snapshot.Error>
  readonly clear: (session: SessionSchema.Info) => Effect.Effect<void, BusyError | NotFoundError | Snapshot.Error>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/SessionRevert") {}

export const make = Effect.fn("SessionRevert.make")(function* () {
  const database = yield* Database.Service
  const bus = yield* Bus.Service
  const plugins = yield* PluginSupervisor.Service
  const snapshot = yield* Snapshot.Service

  const stage: Interface["stage"] = Effect.fn("SessionRevert.stage")(function* (input) {
    yield* plugins.flush
    const original = input.session.revert?.snapshot
      ? Snapshot.ID.make(input.session.revert.snapshot)
      : yield* snapshot.capture()
    const next = yield* plan(database.db, { sessionID: input.session.id, messageID: input.messageID })
    const restore = new Map<RelativePath, Snapshot.ID>()
    if (original) {
      for (const file of input.session.revert?.files ?? []) restore.set(RelativePath.make(file.file), original)
    }
    if (input.files !== false) for (const [file, tree] of next) restore.set(file, tree)
    if (restore.size) yield* snapshot.restore({ files: restore })
    const paths = input.files === false ? [] : Array.from(next.keys())
    const files = original
      ? yield* snapshot.diff({ from: original, to: (yield* snapshot.capture()) ?? original, paths })
      : []
    const revert = {
      messageID: input.messageID,
      snapshot: original,
      files,
    } satisfies SessionSchema.Info["revert"]
    yield* bus
      .command({ type: "stageRevert", payload: { sessionID: input.session.id, revert: encodeRevert(revert) } })
      .pipe(Effect.catch(refused(input.session.id)))
    return revert
  })

  const clear: Interface["clear"] = Effect.fn("SessionRevert.clear")(function* (session) {
    yield* plugins.flush
    if (!session.revert) return
    const original = session.revert.snapshot ? Snapshot.ID.make(session.revert.snapshot) : undefined
    if (original)
      yield* snapshot.restore({
        files: new Map((session.revert.files ?? []).map((file) => [RelativePath.make(file.file), original])),
      })
    yield* bus
      .command({ type: "clearRevert", payload: { sessionID: session.id } })
      .pipe(Effect.catch(refused(session.id)), Effect.asVoid)
  })

  return { stage, clear }
})

export const layer = Layer.effect(Service, make())

/**
 * Commits the Session's staged revert: the runtime cuts its history at the staged message and cancels the
 * input still pending, in one commit. The cut takes the Code Mode values of the executions whose message it
 * removes, and settles those still running; where each message sits is the host's to resolve. Nothing staged
 * is a no-op.
 */
export const commit = Effect.fn("SessionRevert.commit")(function* (
  bus: Bus.Interface,
  db: Database.Interface["db"],
  session: SessionSchema.Info,
) {
  if (!session.revert) return
  const executions = yield* cut(db, { sessionID: session.id, messageID: session.revert.messageID })
  yield* bus
    .command({ type: "commitRevert", payload: { sessionID: session.id, executions } })
    .pipe(Effect.catch(refused(session.id)), Effect.asVoid)
})

/**
 * The Code Mode executions a revert to the message cuts: those still running whose message it removes or that
 * have none yet, and those whose saved values belong to the history it removes, a fork's copies included.
 */
const cut = Effect.fnUntraced(function* (db: Database.Interface["db"], input: BoundaryInput) {
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.messageID)))
    .get()
    .pipe(Effect.orDie)
  if (!boundary) return []
  const running = yield* db
    .select({ id: CodeModeExecutionTable.id, seq: SessionMessageTable.seq })
    .from(CodeModeExecutionTable)
    .leftJoin(
      SessionMessageTable,
      and(
        eq(SessionMessageTable.session_id, CodeModeExecutionTable.session_id),
        eq(SessionMessageTable.id, CodeModeExecutionTable.assistant_message_id),
      ),
    )
    .where(
      and(
        eq(CodeModeExecutionTable.session_id, input.sessionID),
        inArray(CodeModeExecutionTable.status, ["scheduled", "running"]),
      ),
    )
    .all()
    .pipe(Effect.orDie)
  const saved = yield* db
    .selectDistinct({ id: CodeModeBindingTable.execution_id })
    .from(CodeModeBindingTable)
    .where(
      and(eq(CodeModeBindingTable.session_id, input.sessionID), gte(CodeModeBindingTable.message_seq, boundary.seq)),
    )
    .all()
    .pipe(Effect.orDie)
  return [
    ...new Set([
      ...running.filter((row) => row.seq === null || row.seq >= boundary.seq).map((row) => row.id),
      ...saved.map((row) => row.id),
    ]),
  ]
})

const plan = Effect.fn("SessionRevert.plan")(function* (db: Database.Interface["db"], input: BoundaryInput) {
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.messageID)))
    .get()
    .pipe(Effect.orDie)
  if (!boundary) return yield* new MessageNotFoundError(input)
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, input.sessionID),
        eq(SessionMessageTable.type, "assistant"),
        gt(SessionMessageTable.seq, boundary.seq),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const decode = Schema.decodeUnknownEffect(SessionMessage.Info)
  const files = new Map<RelativePath, Snapshot.ID>()
  for (const row of rows) {
    const message = yield* decode({ ...row.data, id: row.id, type: row.type }).pipe(Effect.orDie)
    if (message.type !== "assistant" || !message.snapshot?.start) continue
    for (const file of message.snapshot.files ?? [])
      if (!files.has(file)) files.set(file, Snapshot.ID.make(message.snapshot.start))
  }
  return files
})
