import { KeyValueFact } from "@ocpp/schema/key-value-fact"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: the keys that hold a value. Duplicated from
// store-value on purpose.
export type RemoveValueState = {
  keys: Record<string, true>
}

export const removeValueStore = Context.Service<SliceStoreService<RemoveValueState, RemoveValueState, unknown>>(
  "@ocpp/runtime/RemoveValueStore",
)

export const createRemoveValueState = (): RemoveValueState => ({ keys: {} })

const kvStored = sessionEvent("kv-stored")
const kvRemoved = sessionEvent("kv-removed")

const input = Schema.toStandardSchemaV1(KeyValueFact.Removed.data)

export const removeValue = implementCommand(specification)
  .inputSchema(input)
  .store(removeValueStore)
  .consistencyKeys({ kv: (command) => command.key })
  .apply(kvStored, async (event, state) => {
    state.keys[event.payload.key] = true
  })
  .apply(kvRemoved, async (event, state) => {
    delete state.keys[event.payload.key]
  })
  .handle(async (command, state) => {
    if (!state.keys[command.key]) throw new Error("Value not found")
    return [kvRemoved.create(command)]
  })
