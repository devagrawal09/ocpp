import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core"
import { SpecterEventTable } from "../specter/sql.js"

/** Each aggregate's latest sequence, which its next event follows. */
export const EventSequenceTable = sqliteTable("event_sequence", {
  aggregate_id: text().notNull().primaryKey(),
  seq: integer().notNull(),
})

/**
 * Each fact's sequence in its aggregate: the log holds the events, this only numbers them per aggregate. An
 * aggregate's events are its facts in this order. A projection of the log, written as each fact is recorded.
 */
export const EventTable = sqliteTable(
  "event",
  {
    log_order: integer()
      .primaryKey()
      .references(() => SpecterEventTable.order),
    aggregate_id: text()
      .notNull()
      .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
    seq: integer().notNull(),
  },
  (table) => [uniqueIndex("event_aggregate_seq_idx").on(table.aggregate_id, table.seq)],
)
