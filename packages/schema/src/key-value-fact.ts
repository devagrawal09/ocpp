export * as KeyValueFact from "./key-value-fact.js"

import { Schema } from "effect"
import { Event } from "./event.js"

const byKey = { aggregate: "key", version: 1 } as const

/** A value stored under a key: a plugin's own storage, the web search provider, the well-known origins. */
export const Stored = Event.durable({
  type: "kv.stored",
  durable: byKey,
  schema: { key: Schema.String, value: Schema.Json },
})
export const Removed = Event.durable({
  type: "kv.removed",
  durable: byKey,
  schema: { key: Schema.String },
})

/** Internal persistence facts of the key-value store; its rows are their projection. */
export const Definitions = Event.inventory(Stored, Removed)
