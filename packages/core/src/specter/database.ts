export * as SpecterDatabase from "./database.js"

import { createSqlClientDatabaseContext } from "@ocpp/runtime/sqlite"
import type { Database } from "../database/database.js"

/**
 * OC++'s database as Specter's SQLite stores use it: their statements run through its client and their transactions
 * are Drizzle's, which begin immediately, so a Specter append and OC++'s writes in it share one transaction.
 */
export const make = (db: Database.Interface["db"]) =>
  createSqlClientDatabaseContext(db.$client, {
    transaction: (effect) => db.transaction(() => effect, { behavior: "immediate" }),
  })
