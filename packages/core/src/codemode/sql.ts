import type { CodeMode } from "@ocpp/codemode"
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql.js"
import { SessionTable } from "../session/sql.js"
import type { SessionMessage } from "../session/message.js"
import type { SessionSchema } from "../session/schema.js"

/**
 * One durable notebook value. Names are immutable and never reused, so this append-only table is
 * both the current notebook and its history: a fork copies rows through its boundary and a committed
 * revert deletes rows from its boundary onward.
 */
export const CodeModeBindingTable = sqliteTable(
  "codemode_binding",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    value: text({ mode: "json" }).$type<CodeMode.NotebookValue>().notNull(),
    message_seq: integer().notNull(),
    execution_id: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.name] }),
    index("codemode_binding_session_seq_idx").on(table.session_id, table.message_seq),
  ],
)

/** A name held by an admitted execution. The primary key makes reservation atomic and exclusive. */
export const CodeModeReservationTable = sqliteTable(
  "codemode_reservation",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    execution_id: text().notNull(),
    time_created: integer().notNull().$defaultFn(Date.now),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.name] }),
    index("codemode_reservation_execution_idx").on(table.execution_id),
  ],
)

export const CodeModeExecutionTable = sqliteTable(
  "codemode_execution",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    assistant_message_id: text().$type<SessionMessage.ID>().notNull(),
    tool_call_id: text().notNull(),
    status: text().$type<"scheduled" | "running" | "saved" | "failed" | "indeterminate">().notNull(),
    program: text({ mode: "json" }).$type<CodeMode.Program>().notNull(),
    /** Queryable copy of the program's IR version, so stored programs can be audited in SQL. */
    ir_version: integer().notNull(),
    /**
     * Notebook names visible to this execution, captured when it was admitted. Admission fixes the
     * snapshot, so this records what the execution was allowed to see even after later executions
     * add names.
     */
    snapshot: text({ mode: "json" }).$type<ReadonlyArray<string>>().notNull(),
    saved: text({ mode: "json" }).$type<ReadonlyArray<string>>(),
    error: text(),
    ...Timestamps,
    time_completed: integer(),
  },
  (table) => [index("codemode_execution_session_created_idx").on(table.session_id, table.time_created)],
)

export const CodeModeJournalTable = sqliteTable(
  "codemode_journal",
  {
    execution_id: text()
      .notNull()
      .references(() => CodeModeExecutionTable.id, { onDelete: "cascade" }),
    call_index: integer().notNull(),
    tool: text().notNull(),
    input: text({ mode: "json" }).$type<unknown>().notNull(),
    status: text().$type<"scheduled" | "completed" | "failed" | "indeterminate">().notNull(),
    output: text({ mode: "json" }).$type<unknown>(),
    error: text(),
    ...Timestamps,
    time_completed: integer(),
  },
  (table) => [primaryKey({ columns: [table.execution_id, table.call_index] })],
)
