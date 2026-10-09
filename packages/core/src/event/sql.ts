import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Event } from "@ocpp/schema/event"
import { SpecterEventTable } from "../specter/sql.js"

/** Each aggregate's latest sequence, which its next event follows. */
export const EventSequenceTable = sqliteTable("event_sequence", {
  aggregate_id: text().notNull().primaryKey(),
  seq: integer().notNull(),
})

/**
 * Each aggregate's events by sequence, and the fact in Specter's log each one is: the log holds the
 * events, this only orders them per aggregate. A projection of the log, written as each fact is
 * recorded.
 */
export const EventTable = sqliteTable(
  "event",
  {
    id: text().$type<Event.ID>().primaryKey(),
    aggregate_id: text()
      .notNull()
      .references(() => EventSequenceTable.aggregate_id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    created: integer().notNull().default(0),
    type: text().notNull(),
    log_order: integer()
      .notNull()
      .references(() => SpecterEventTable.order),
  },
  (table) => [
    uniqueIndex("event_aggregate_seq_idx").on(table.aggregate_id, table.seq),
    index("event_aggregate_type_seq_idx").on(table.aggregate_id, table.type, table.seq),
  ],
)
