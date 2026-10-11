import { SessionFact } from "@ocpp/schema/session-fact"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// A marker can always start: a new job takes a fresh notification, and a
// resumed one starts again under its own, settled or not. It folds nothing,
// so the scenario that resumes a settled job needs no state.
export type BackgroundJobState = Record<string, never>

export const backgroundJobStore = Context.Service<SliceStoreService<BackgroundJobState, BackgroundJobState, unknown>>(
  "@ocpp/runtime/BackgroundJobStore",
)

export const createBackgroundJobState = (): BackgroundJobState => ({})

const backgroundStarted = sessionEvent("session-background-started")
const backgroundSettled = sessionEvent("session-background-settled")

const { notificationID: _, ...outcome } = SessionFact.BackgroundSettled.data.fields
const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    ...SessionFact.BackgroundStarted.data.fields,
    // How the job ended, when it ended before it went to the background.
    settled: Schema.optional(Schema.Struct(outcome)),
  }),
)

export const backgroundJob = implementCommand(specification)
  .inputSchema(input)
  .store(backgroundJobStore)
  .consistencyKeys((command) => [command.notificationID])
  .apply(backgroundStarted, async () => {})
  .apply(backgroundSettled, async () => {})
  .handle(async (command) => {
    const { settled, ...started } = command
    return [
      backgroundStarted.create(started),
      ...(settled === undefined
        ? []
        : [backgroundSettled.create({ notificationID: started.notificationID, ...settled })]),
    ]
  })
