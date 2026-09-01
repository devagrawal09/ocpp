import type { CodeMode } from "@opencode-ai/codemode"
import type { Schema } from "effect"
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql.js"
import { SessionTable } from "../session/sql.js"
import type { SessionMessage } from "../session/message.js"
import type { SessionSchema } from "../session/schema.js"

export const CodeModeNotebookTable = sqliteTable("codemode_notebook", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  revision: integer().notNull().default(0),
  ...Timestamps,
})

export const CodeModeBindingTable = sqliteTable(
  "codemode_binding",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    revision: integer().notNull(),
    value: text({ mode: "json" }).$type<Schema.Json>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.session_id, table.name] })],
)

export const CodeModeBindingHistoryTable = sqliteTable(
  "codemode_binding_history",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    revision: integer().notNull(),
    message_seq: integer().notNull(),
    name: text().notNull(),
    value: text({ mode: "json" }).$type<Schema.Json>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.revision, table.name] }),
    index("codemode_binding_history_session_name_revision_idx").on(table.session_id, table.name, table.revision),
  ],
)

export const CodeModeActivationTable = sqliteTable(
  "codemode_activation",
  {
    id: text().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    assistant_message_id: text().$type<SessionMessage.ID>().notNull(),
    tool_call_id: text().notNull(),
    base_revision: integer().notNull(),
    mode: text().$type<"required" | "detached">().notNull(),
    status: text().$type<"scheduled" | "running" | "completed" | "failed" | "indeterminate">().notNull(),
    program: text({ mode: "json" }).$type<CodeMode.Program>().notNull(),
    ir_version: integer().notNull(),
    error: text(),
    ...Timestamps,
    time_completed: integer(),
  },
  (table) => [index("codemode_activation_session_created_idx").on(table.session_id, table.time_created)],
)

export const CodeModeJournalTable = sqliteTable(
  "codemode_journal",
  {
    activation_id: text()
      .notNull()
      .references(() => CodeModeActivationTable.id, { onDelete: "cascade" }),
    call_index: integer().notNull(),
    tool: text().notNull(),
    input: text({ mode: "json" }).$type<Schema.Json>().notNull(),
    status: text().$type<"scheduled" | "completed" | "failed" | "indeterminate">().notNull(),
    output: text({ mode: "json" }).$type<Schema.Json>(),
    error: text(),
    ...Timestamps,
    time_completed: integer(),
  },
  (table) => [primaryKey({ columns: [table.activation_id, table.call_index] })],
)

export const CodeModeResultTable = sqliteTable("codemode_result", {
  activation_id: text()
    .primaryKey()
    .references(() => CodeModeActivationTable.id, { onDelete: "cascade" }),
  status: text().$type<"completed" | "failed" | "indeterminate">().notNull(),
  data: text({ mode: "json" }).$type<CodeMode.Result>().notNull(),
  bytes: integer().notNull(),
  ...Timestamps,
})
