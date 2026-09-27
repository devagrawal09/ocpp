import type { CodeModeEvent } from "@ocpp/schema/codemode-event"
import type { Schema } from "effect"
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql.js"
import { SessionTable } from "../session/sql.js"
import type { SessionMessage } from "../session/message.js"
import type { SessionSchema } from "../session/schema.js"

/**
 * A Session's scheduled events and their latest firing. The process-local scheduler records the next
 * fire time here so listings can show it; the latest run's outcome is read from its execution.
 */
export const CodeModeEventTable = sqliteTable(
  "codemode_event",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text().notNull(),
    schedule: text({ mode: "json" }).$type<CodeModeEvent.Schedule>().notNull(),
    handler: text().notNull(),
    input: text({ mode: "json" }).$type<Schema.Json>(),
    enabled: integer({ mode: "boolean" }).notNull(),
    time_next: integer(),
    time_fired: integer(),
    /** The latest firing's execution and invocation message; unset when it could not start. */
    execution_id: text(),
    message_id: text().$type<SessionMessage.ID>(),
    /** Why the latest firing could not start. */
    error: text(),
    run_count: integer().notNull().default(0),
    skip_count: integer().notNull().default(0),
    time_skipped: integer(),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.session_id, table.name] })],
)
