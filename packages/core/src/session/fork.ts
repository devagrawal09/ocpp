export * as SessionFork from "./fork.js"

import { and, asc, eq, lt, lte, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import type { Database } from "../database/database.js"
import { CodeModeCommandTable } from "../codemode/command.sql.js"
import { CodeModeEventTable } from "../codemode/event.sql.js"
import { CodeModeBindingTable } from "../codemode/sql.js"
import type { SessionEvent } from "./event.js"
import { InstructionEntry } from "./instruction-entry.js"
import { InstructionState } from "./instruction-state.js"
import { SessionMessage } from "./message.js"
import type { SessionSchema } from "./schema.js"
import { SessionMessageTable, SessionTable } from "./sql.js"

type DatabaseService = Database.Interface["db"]

/**
 * At most how many bytes of copied messages one fact of a fork's history holds. A long history is copied in several
 * facts of the fork's one commit, so no one fact, row or decode grows with it.
 */
export const historyPageBytes = 1024 * 1024

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Info)
const encodeMessage = Schema.encodeSync(SessionMessage.Info)

/**
 * What a fork inherits of its parent, read from the parent's projection in one transaction: the parent as stored,
 * which keeps its version and selections, and what the fork's facts carry. Those are its settled history through the
 * boundary, the Code Mode notebook values that history saved with the parent's commands and events, the parent's newest
 * instruction values with the values they refer to, its instruction entries and its tool list. Nothing of the fork
 * reads its parent again, so it outlives its parent's purge. Undefined when the parent is gone.
 */
export const inherit = Effect.fn("SessionFork.inherit")(function* (
  db: DatabaseService,
  input: { readonly parentID: SessionSchema.ID; readonly boundary: SessionEvent.Forked["data"]["boundary"] },
) {
  return yield* db
    .transaction(() =>
      Effect.gen(function* () {
        const row = yield* db.select().from(SessionTable).where(eq(SessionTable.id, input.parentID)).get()
        if (!row) return undefined
        const boundary = yield* db
          .select({ seq: SessionMessageTable.seq })
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, input.parentID),
              eq(SessionMessageTable.id, input.boundary.messageID),
            ),
          )
          .get()
        if (!boundary)
          return yield* Effect.die(new Error(`Fork boundary message not found: ${input.boundary.messageID}`))
        // Through the boundary: up to the message before it, or up to it.
        const through = (seq: typeof SessionMessageTable.seq | typeof CodeModeBindingTable.message_seq) =>
          input.boundary.type === "before" ? lt(seq, boundary.seq) : lte(seq, boundary.seq)
        const messages = yield* db
          .select()
          .from(SessionMessageTable)
          .where(
            and(
              eq(SessionMessageTable.session_id, input.parentID),
              through(SessionMessageTable.seq),
              // What still runs stays with the parent, so a fork copies only settled history.
              sql`${SessionMessageTable.type} != 'assistant' or json_extract(${SessionMessageTable.data}, '$.time.completed') is not null`,
              sql`${SessionMessageTable.type} != 'shell' or json_extract(${SessionMessageTable.data}, '$.status') != 'running'`,
              sql`${SessionMessageTable.type} != 'compaction' or json_extract(${SessionMessageTable.data}, '$.status') != 'running'`,
              sql`${SessionMessageTable.type} != 'invocation' or json_extract(${SessionMessageTable.data}, '$.status') != 'running'`,
            ),
          )
          .orderBy(asc(SessionMessageTable.seq))
          .all()
        // The values saved by the executions whose message the history copies.
        const values = yield* db
          .select()
          .from(CodeModeBindingTable)
          .where(and(eq(CodeModeBindingTable.session_id, input.parentID), through(CodeModeBindingTable.message_seq)))
          .all()
        const commands = yield* db
          .select()
          .from(CodeModeCommandTable)
          .where(eq(CodeModeCommandTable.session_id, input.parentID))
          .all()
        const events = yield* db
          .select()
          .from(CodeModeEventTable)
          .where(eq(CodeModeEventTable.session_id, input.parentID))
          .all()
        const instructions = yield* InstructionState.current(db, input.parentID)
        return {
          row,
          instructions,
          instructionEntries: yield* InstructionEntry.snapshot(db, input.parentID),
          ...(row.tools === null ? {} : { tools: row.tools }),
          ...(instructions === undefined ? {} : { blobs: yield* InstructionState.blobs(db, instructions) }),
          history: {
            messages: messages.map((message) => ({
              type: message.type,
              seq: message.seq,
              created: message.time_created,
              updated: message.time_updated,
              // The row's data, as JSON: what its projection stored.
              data: (message.type === "assistant" ? settledCodeMode(message) : message.data) as Schema.Json,
            })),
            pageBytes: historyPageBytes,
          },
          notebook: {
            values: Object.fromEntries(
              values.map((value) => [
                value.name,
                { value: value.value as Schema.Json, executionID: value.execution_id, seq: value.message_seq },
              ]),
            ),
            commands: Object.fromEntries(
              commands.map((command) => [
                command.name,
                {
                  description: command.description,
                  handler: command.handler,
                  created: command.time_created,
                  updated: command.time_updated,
                },
              ]),
            ),
            events: Object.fromEntries(
              events.map((event) => [
                event.name,
                {
                  description: event.description,
                  schedule: event.schedule,
                  handler: event.handler,
                  ...(event.input === null ? {} : { input: event.input }),
                  created: event.time_created,
                  updated: event.time_updated,
                },
              ]),
            ),
          },
        }
      }),
    )
    .pipe(Effect.orDie)
})

/**
 * An execution belongs to the Session that admitted it: its completion notification and the notebook
 * values it saves stay on the parent. A fork copies the settled tool result that announced it, so
 * that result is rewritten to stop promising a notification the child will never receive. This
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
