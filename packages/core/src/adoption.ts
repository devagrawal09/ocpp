export * as Adoption from "./adoption.js"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { AdoptionFact } from "@ocpp/schema/adoption-fact"
import type { Event } from "@ocpp/schema/event"
import type { Database } from "./database/database.js"

/**
 * The tables OC++ projects from Specter's log, each with the column that names the aggregate a row belongs
 * to, parents before the rows that refer to them. Specter's own tables, the event index, caches and
 * credential keys are not projections.
 */
export const Tables = {
  project: "id",
  worktree: "project_id",
  workspace: "id",
  session_v2: "id",
  session_message: "session_id",
  session_inbox: "session_id",
  session_external: "session_id",
  instruction_blob: "hash",
  instruction_state: "session_id",
  instruction_entry: "session_id",
  codemode_execution: "id",
  codemode_journal: "execution_id",
  codemode_binding: "session_id",
  codemode_reservation: "session_id",
  codemode_command: "session_id",
  codemode_event: "session_id",
  credential: "id",
  credential_secret: "credential_id",
  kv: "key",
  job_background: "notification_id",
} as const satisfies Record<string, string>
export type Table = keyof typeof Tables

export const isTable = (table: string): table is Table => Object.hasOwn(Tables, table)

type Row = { readonly [column: string]: unknown }

/**
 * Projects adopted rows: the aggregate's rows in the table become exactly the adopted ones. Rows it no
 * longer has go, and each adopted row is written column by column as it was stored.
 */
export const projector = (db: Database.Interface["db"]) => {
  const keys = new Map<Table, readonly string[]>()
  const primaryKey = (table: Table) =>
    Effect.gen(function* () {
      const known = keys.get(table)
      if (known) return known
      const columns = yield* db
        .all<{ readonly name: string; readonly pk: number }>(sql.raw(`PRAGMA table_info("${table}")`))
        .pipe(Effect.orDie)
      const key = columns
        .filter((column) => column.pk > 0)
        .toSorted((a, b) => a.pk - b.pk)
        .map((column) => column.name)
      keys.set(table, key)
      return key
    })
  const identity = (key: readonly string[], row: Row) => JSON.stringify(key.map((column) => row[column]))

  return (event: Event.Payload<typeof AdoptionFact.Adopted>) =>
    Effect.gen(function* () {
      const { table, aggregate, rows } = event.data
      if (!isTable(table)) return yield* Effect.die(new Error(`Cannot adopt rows of ${table}`))
      const key = yield* primaryKey(table)
      const column = sql.identifier(Tables[table])
      const adopted = new Set(rows.map((row) => identity(key, row)))
      const stored = yield* db
        .all<Row>(
          sql`SELECT ${sql.join(
            key.map((name) => sql.identifier(name)),
            sql`, `,
          )} FROM ${sql.identifier(table)} WHERE ${column} = ${aggregate}`,
        )
        .pipe(Effect.orDie)
      for (const row of stored) {
        if (adopted.has(identity(key, row))) continue
        yield* db
          .run(
            sql`DELETE FROM ${sql.identifier(table)} WHERE ${sql.join(
              key.map((name) => sql`${sql.identifier(name)} = ${row[name]}`),
              sql` AND `,
            )}`,
          )
          .pipe(Effect.orDie)
      }
      for (const row of rows) {
        const columns = Object.keys(row)
        const values = columns.map((name) => sql`${row[name] as string | number | null}`)
        const updates = columns.filter((name) => !key.includes(name))
        yield* db
          .run(
            sql`INSERT INTO ${sql.identifier(table)} (${sql.join(
              columns.map((name) => sql.identifier(name)),
              sql`, `,
            )}) VALUES (${sql.join(values, sql`, `)}) ON CONFLICT (${sql.join(
              key.map((name) => sql.identifier(name)),
              sql`, `,
            )}) ${
              updates.length === 0
                ? sql`DO NOTHING`
                : sql`DO UPDATE SET ${sql.join(
                    updates.map((name) => sql`${sql.identifier(name)} = excluded.${sql.identifier(name)}`),
                    sql`, `,
                  )}`
            }`,
          )
          .pipe(Effect.orDie)
      }
    })
}
