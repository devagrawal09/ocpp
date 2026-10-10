import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { refusal } from "./decided.ts"
import specification from "./spec.json" with { type: "json" }

// Records facts as the host gives them, except those a Command of their own
// decides: it folds nothing.
export type RecordSessionFactsState = Record<string, never>

export const recordSessionFactsStore = Context.Service<
  SliceStoreService<RecordSessionFactsState, RecordSessionFactsState, unknown>
>("@ocpp/runtime/RecordSessionFactsStore")

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
  .handle(async (command) => {
    const refused = command.facts.map((fact) => refusal(fact.type)).find((reason) => reason !== undefined)
    if (refused) throw new Error(refused)
    return command.facts
  })
