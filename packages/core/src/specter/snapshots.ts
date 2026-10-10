export * as SpecterSnapshots from "./snapshots.js"

import { lt } from "drizzle-orm"
import { Duration, Effect, Schedule } from "effect"
import { makeSnapshotSliceStores, type SliceSnapshot } from "@ocpp/session-runtime"
import type { Database } from "../database/database.js"
import { SpecterSliceSnapshotTable } from "./sql.js"

type DatabaseService = Database.Interface["db"]

const table = SpecterSliceSnapshotTable

const save = (db: DatabaseService, snapshots: readonly SliceSnapshot[]) =>
  db.transaction(
    () =>
      Effect.forEach(
        snapshots,
        (snapshot) =>
          db
            .insert(table)
            .values({ slice: snapshot.slice, state: snapshot.state, cursor: snapshot.cursor, saved_at: Date.now() })
            .onConflictDoUpdate({
              target: table.slice,
              set: { state: snapshot.state, cursor: snapshot.cursor, saved_at: Date.now() },
              // Two runtimes fold some Slices alike (the Bus's facts); the later cursor wins.
              setWhere: lt(table.cursor, snapshot.cursor),
            })
            .run(),
        { discard: true },
      ),
    { behavior: "immediate" },
  )

/**
 * Slice Stores for a runtime, kept in memory, that start from the snapshots in OC++'s database and save
 * theirs back every minute and once the runtime has closed, so a boot catches each Slice up after its
 * cursor instead of folding the log. Build the runtime after this, in the same scope: the last save then
 * runs after the runtime closes.
 */
export const persisted = (db: DatabaseService) =>
  Effect.gen(function* () {
    const rows = yield* db.select().from(table).all().pipe(Effect.orDie)
    const stores = makeSnapshotSliceStores(
      rows.map((row) => ({ slice: row.slice, state: row.state, cursor: row.cursor })),
    )
    // A Slice that has not moved since its last save is left out.
    const flush = Effect.suspend(() => {
      const taken = stores.snapshot()
      return taken.length === 0 ? Effect.void : save(db, taken)
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Failed to save Specter slice snapshots", cause)))
    yield* Effect.addFinalizer(() => flush)
    yield* flush.pipe(
      Effect.repeat(Schedule.spaced(Duration.minutes(1))),
      Effect.delay(Duration.minutes(1)),
      Effect.forkScoped,
    )
    return stores.provide
  })
