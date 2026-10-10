export * as DatabaseMigration from "./migration.js"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import { supportsForeignKeyToggle } from "#sqlite"
import type { EffectDrizzleSqlite } from "./drizzle.js"
import { migrations } from "./migration.gen.js"
import { Global } from "@ocpp/util/global"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

export type Migration = {
  id: string
  foreignKeys?: boolean
  up: (tx: Transaction) => Effect.Effect<void, unknown, Global.Service>
}

/**
 * Brings the database to the current schema: an empty one runs every migration from the baseline, and one
 * OC++ created runs those it has not. OC++ does not upgrade a database created before its baseline, nor one
 * it did not create.
 */
export function apply(db: Database) {
  return lock.withPermit(
    Effect.gen(function* () {
      // OC++ owns the unprefixed table namespace. Embedders sharing this
      // database may own underscore-prefixed tables, which it ignores.
      const tables = yield* db.all<{ name: string }>(
        sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 1) <> '_'`,
      )
      const baseline = migrations[0]!
      const created =
        tables.some((table) => table.name === "migration") &&
        (yield* db.get(sql`SELECT id FROM ${sql.identifier("migration")} WHERE id = ${baseline.id}`)) !== undefined
      if (tables.length > 0 && !created)
        return yield* Effect.die(
          new Error(`Database has tables but not OC++'s baseline schema (${baseline.id}), so OC++ cannot upgrade it`),
        )
      yield* applyOnly(db, migrations)
    }),
  )
}

export function applyOnly(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )
    const completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      const started = Date.now()
      yield* Effect.logInfo("database migration started", { migration: migration.id })
      const apply = db.transaction((tx) =>
        Effect.gen(function* () {
          yield* migration.up(tx)
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          )
        }),
      )
      const run =
        migration.foreignKeys !== false
          ? apply
          : Effect.gen(function* () {
              // Durable Object SQLite rejects the foreign_keys toggle; the closest
              // allowlisted relaxation is deferring enforcement to transaction commit.
              const relaxForeignKeys = supportsForeignKeyToggle
                ? db.run(sql`PRAGMA foreign_keys = OFF`)
                : db.run(sql`PRAGMA defer_foreign_keys = ON`)
              const restoreForeignKeys = supportsForeignKeyToggle ? db.run(sql`PRAGMA foreign_keys = ON`) : Effect.void
              yield* relaxForeignKeys
              yield* apply.pipe(Effect.ensuring(restoreForeignKeys.pipe(Effect.orDie)))
            })
      yield* run.pipe(
        Effect.tapError((error) =>
          Effect.logError("database migration failed", {
            migration: migration.id,
            durationMs: Date.now() - started,
            error,
          }),
        ),
      )
      yield* Effect.logInfo("database migration completed", {
        migration: migration.id,
        durationMs: Date.now() - started,
      })
    }
  })
}
