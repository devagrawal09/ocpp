export * as AdoptionFact from "./adoption-fact.js"

import { Schema } from "effect"
import { Event } from "./event.js"

/**
 * Rows OC++ stored without a fact behind them, recorded as they are: what a database held before Specter's
 * log did, and what an importer converts from another format. `rows` are all of the aggregate's rows in
 * `table`, column by column as stored; the projection makes the table hold exactly them.
 */
export const Adopted = Event.durable({
  type: "rows.adopted",
  durable: { aggregate: "aggregate", version: 1 },
  schema: {
    aggregate: Schema.String,
    table: Schema.String,
    rows: Schema.Array(Schema.Record(Schema.String, Schema.Json)),
  },
})

/** Internal persistence facts; their rows are their projection. */
export const Definitions = Event.inventory(Adopted)
