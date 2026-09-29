import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql.js"
import { SessionTable } from "../session/sql.js"
import type { SessionSchema } from "../session/schema.js"

/** A Session's slash commands. Each one names the notebook function its invocations call. */
export const CodeModeCommandTable = sqliteTable(
  "codemode_command",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text().notNull(),
    handler: text().notNull(),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.session_id, table.name] })],
)
