import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

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

/**
 * The jobs of the runtime's outboxed Reactions (its steps, and the executions an external agent drives).
 * A job is enqueued once per Reaction delivery: a delivery replayed at boot dedupes against it.
 */
export const SpecterOutboxJobTable = sqliteTable(
  "specter_outbox_job",
  {
    id: text().primaryKey(),
    reaction: text().notNull(),
    idempotency_key: text().notNull(),
    /** Jobs with the same key never run at once: one Session's jobs run one at a time. */
    concurrency_key: text(),
    payload: text({ mode: "json" }).$type<unknown>().notNull(),
    status: text().$type<"pending" | "running" | "completed" | "dead-letter">().notNull(),
    requested_at: integer().notNull(),
    available_at: integer().notNull(),
    attempt_count: integer().notNull(),
    active_attempt_id: text(),
    lease_expires_at: integer(),
    completed_at: integer(),
    last_error: text(),
  },
  (table) => [
    uniqueIndex("specter_outbox_job_key_idx").on(table.reaction, table.idempotency_key),
    index("specter_outbox_job_claim_idx").on(table.reaction, table.status, table.available_at),
  ],
)

/** Each runtime Slice's state as of its cursor, so a boot catches up after it instead of folding the log. */
export const SpecterSliceSnapshotTable = sqliteTable("specter_slice_snapshot", {
  slice: text().primaryKey(),
  state: text({ mode: "json" }).$type<unknown>().notNull(),
  cursor: integer().notNull(),
  saved_at: integer().notNull(),
})
