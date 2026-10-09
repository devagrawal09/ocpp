import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * Specter's Event Log, kept in OC++'s database so a Specter commit and OC++'s projections share one
 * transaction. `order` is the log's global position; a commit's version is the order of its last event.
 */
export const SpecterEventTable = sqliteTable(
  "specter_event",
  {
    order: integer().primaryKey({ autoIncrement: true }),
    id: text().notNull().unique(),
    type: text().notNull(),
    payload: text({ mode: "json" }).$type<unknown>().notNull(),
    recorded_at: text().notNull(),
  },
  (table) => [index("specter_event_type_order_idx").on(table.type, table.order)],
)

export const SpecterCommitTable = sqliteTable("specter_commit", {
  version: integer().primaryKey(),
  idempotency_key: text().unique(),
  fingerprint: text(),
  first_order: integer().notNull(),
  committed_at: text().notNull(),
})
