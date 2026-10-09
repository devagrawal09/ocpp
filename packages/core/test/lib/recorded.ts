export * as Recorded from "./recorded.js"

import { asc, eq, getTableColumns, type SQL } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@ocpp/core/database/database"
import { EventTable } from "@ocpp/core/event/sql"
import { SpecterEventTable } from "@ocpp/core/specter/sql"
import { SpecterTranslate } from "@ocpp/core/specter/translate"

/**
 * Recorded events in the order they were recorded, each with its data as recorded (encoded): read from
 * Specter's log through the event index. `where` filters the index (`EventTable` columns).
 */
export const events = (where?: SQL) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select({
        ...getTableColumns(EventTable),
        fact: {
          id: SpecterEventTable.id,
          order: SpecterEventTable.order,
          type: SpecterEventTable.type,
          payload: SpecterEventTable.payload,
          recordedAt: SpecterEventTable.recorded_at,
        },
      })
      .from(EventTable)
      .innerJoin(SpecterEventTable, eq(SpecterEventTable.order, EventTable.log_order))
      .where(where)
      .orderBy(asc(EventTable.log_order), asc(EventTable.seq))
      .all()
      .pipe(Effect.orDie)
    return rows.map(({ fact, log_order: _, ...row }) => ({
      ...row,
      // An archived event is the fact itself; otherwise it is one of the fact's translations.
      data: (fact.type === row.type
        ? fact.payload
        : SpecterTranslate.toWire(fact).find((wire) => wire.id === row.id)?.data) as Record<string, unknown>,
    }))
  })
