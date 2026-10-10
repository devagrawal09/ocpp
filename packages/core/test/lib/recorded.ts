export * as Recorded from "./recorded.js"

import { asc, eq, type SQL } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@ocpp/core/database/database"
import { EventTable } from "@ocpp/core/event/sql"
import { SpecterEventTable } from "@ocpp/core/specter/sql"

/**
 * Recorded events in the order they were recorded, each with its data as recorded (encoded): the facts in
 * Specter's log, with their aggregate sequence from the event index. `where` filters the index (`EventTable`
 * columns) or the log (`SpecterEventTable` columns).
 */
export const events = (where?: SQL) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({
        id: SpecterEventTable.id,
        aggregate_id: EventTable.aggregate_id,
        seq: EventTable.seq,
        type: SpecterEventTable.type,
        data: SpecterEventTable.payload,
      })
      .from(EventTable)
      .innerJoin(SpecterEventTable, eq(SpecterEventTable.order, EventTable.log_order))
      .where(where)
      .orderBy(asc(EventTable.log_order))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map((row) => ({ ...row, data: row.data as Record<string, unknown> }))),
      )
  })

/** The types of an aggregate's recorded events, in sequence order. */
export const types = (aggregateID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ type: SpecterEventTable.type })
      .from(EventTable)
      .innerJoin(SpecterEventTable, eq(SpecterEventTable.order, EventTable.log_order))
      .where(eq(EventTable.aggregate_id, aggregateID))
      .orderBy(asc(EventTable.seq))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map((row) => row.type)),
      )
  })
