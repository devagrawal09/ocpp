import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { Event } from "@ocpp/schema/event"
import type { DatabaseMigration } from "../migration.js"

// The tables OC++ projects from Specter's log, each with the column naming the aggregate a row belongs to,
// parents first, as they are when this migration was written.
const tables = [
  ["project", "id"],
  ["worktree", "project_id"],
  ["workspace", "id"],
  ["session_v2", "id"],
  ["session_message", "session_id"],
  ["session_inbox", "session_id"],
  ["session_external", "session_id"],
  ["instruction_blob", "hash"],
  ["instruction_state", "session_id"],
  ["instruction_entry", "session_id"],
  ["codemode_execution", "id"],
  ["codemode_journal", "execution_id"],
  ["codemode_binding", "session_id"],
  ["codemode_reservation", "session_id"],
  ["codemode_command", "session_id"],
  ["codemode_event", "session_id"],
  ["credential", "id"],
  ["credential_secret", "credential_id"],
  ["kv", "key"],
  ["job_background", "notification_id"],
] as const

const migration: DatabaseMigration.Migration = {
  id: "20261009230400_adopt_rows",
  up(tx) {
    return Effect.gen(function* () {
      // Every row stored so far was written without a fact behind it. Each aggregate's rows in each table are
      // recorded in Specter's log as they are (`rows.adopted`), so rebuilding from the log writes them again.
      const recordedAt = new Date().toISOString()
      const created = Date.now()
      for (const [table, column] of tables) {
        const rows = yield* tx.all<Record<string, unknown>>(
          sql.raw(`SELECT * FROM "${table}"${table === "session_v2" ? ` ORDER BY "time_created", "id"` : ""}`),
        )
        const aggregates = new Map<string, Record<string, unknown>[]>()
        for (const row of rows) {
          const aggregate = String(row[column])
          aggregates.set(aggregate, [...(aggregates.get(aggregate) ?? []), row])
        }
        for (const [aggregate, adopted] of aggregates) {
          const id = Event.ID.create()
          const fact = yield* tx.get<{ order: number }>(sql`
            INSERT INTO specter_event (id, type, payload, recorded_at)
            VALUES (${id}, 'rows-adopted', ${JSON.stringify({ aggregate, table, rows: adopted })}, ${recordedAt})
            RETURNING "order"
          `)
          yield* tx.run(sql`
            INSERT INTO specter_commit (version, idempotency_key, fingerprint, first_order, committed_at)
            VALUES (${fact!.order}, ${`adopt:${id}`}, NULL, ${fact!.order}, ${recordedAt})
          `)
          yield* tx.run(sql`
            INSERT INTO event_sequence (aggregate_id, seq) VALUES (${aggregate}, 0)
            ON CONFLICT (aggregate_id) DO UPDATE SET seq = seq + 1
          `)
          yield* tx.run(sql`
            INSERT INTO event (id, aggregate_id, seq, created, type, log_order)
            SELECT ${id}, ${aggregate}, seq, ${created}, 'rows.adopted.1', ${fact!.order}
            FROM event_sequence WHERE aggregate_id = ${aggregate}
          `)
        }
      }
    })
  },
}

export default migration
