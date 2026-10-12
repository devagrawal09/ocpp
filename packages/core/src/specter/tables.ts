import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Specter's Event Log table, which Specter's SQLite Event Log owns and the baseline migration creates from
 * `sqliteEventLogSchema`. Declared here only so OC++'s queries can join its event index (`event.log_order`) to the
 * facts: drizzle-kit's schema leaves this file out, so it never declares or migrates the table.
 */
export const SpecterEventTable = sqliteTable("specter_events", {
  event_order: integer().primaryKey({ autoIncrement: true }),
  id: text().notNull(),
  type: text().notNull(),
  payload: text({ mode: "json" }).$type<unknown>().notNull(),
  recorded_at: text().notNull(),
})
