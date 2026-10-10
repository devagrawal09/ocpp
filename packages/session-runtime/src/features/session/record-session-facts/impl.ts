import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import specification from "./spec.json" with { type: "json" }

// Records facts as the host gives them: the Command decides nothing, so it
// folds nothing.
export type RecordSessionFactsState = Record<string, never>

export const recordSessionFactsStore = Context.Service<
  SliceStoreService<RecordSessionFactsState, RecordSessionFactsState, unknown>
>("@ocpp/session-runtime/RecordSessionFactsStore")

export const createRecordSessionFactsState = (): RecordSessionFactsState => ({})

// Each payload is decoded by its event's definition (OC++'s schema) when the
// runtime stores it, so the input only names the fact.
const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    facts: Schema.NonEmptyArray(Schema.Struct({ type: Schema.String, payload: Schema.Unknown })),
  }),
)

export const recordSessionFacts = implementCommand(specification)
  .inputSchema(input)
  .store(recordSessionFactsStore)
  .handle(async (command) => command.facts)
