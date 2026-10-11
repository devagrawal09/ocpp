import { createHash } from "node:crypto"
import { KeyValueFact } from "@ocpp/schema/key-value-fact"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: a digest of the value each key holds, as JSON, so
// the state stays small whatever the values are. Duplicated from
// remove-value on purpose.
export type StoreValueState = {
  values: Record<string, string>
}

export const storeValueStore = Context.Service<SliceStoreService<StoreValueState, StoreValueState, unknown>>(
  "@ocpp/runtime/StoreValueStore",
)

export const createStoreValueState = (): StoreValueState => ({ values: {} })

const kvStored = sessionEvent("kv-stored")
const kvRemoved = sessionEvent("kv-removed")

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("base64")

const input = Schema.toStandardSchemaV1(KeyValueFact.Stored.data)

export const storeValue = implementCommand(specification)
  .inputSchema(input)
  .store(storeValueStore)
  .apply(kvStored, async (event, state) => {
    state.values[event.payload.key] = digest(event.payload.value)
  })
  .apply(kvRemoved, async (event, state) => {
    delete state.values[event.payload.key]
  })
  .handle(async (command, state) => {
    if (state.values[command.key] === digest(command.value)) throw new Error("Value unchanged")
    return [kvStored.create(command)]
  })
