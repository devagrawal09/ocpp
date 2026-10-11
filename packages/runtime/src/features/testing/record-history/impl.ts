import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import specification from "./spec.json" with { type: "json" }

// Records facts as a test gives them: it folds nothing.
export type RecordHistoryState = Record<string, never>

export const recordHistoryStore = Context.Service<SliceStoreService<RecordHistoryState, RecordHistoryState, unknown>>(
  "@ocpp/runtime/RecordHistoryStore",
)

export const createRecordHistoryState = (): RecordHistoryState => ({})

// Each payload is decoded by its event's definition (OC++'s schema) when the
// runtime stores it, so the input only names the fact.
const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    facts: Schema.NonEmptyArray(Schema.Struct({ type: Schema.String, payload: Schema.Unknown })),
  }),
)

export const recordHistory = implementCommand(specification)
  .inputSchema(input)
  .store(recordHistoryStore)
  .handle(async (command) => command.facts)
