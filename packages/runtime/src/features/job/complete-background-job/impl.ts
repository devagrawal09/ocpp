import { SessionFact } from "@ocpp/schema/session-fact"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: the markers not yet completed, by notification.
// Duplicated from the other marker Slices on purpose.
export type CompleteBackgroundJobState = {
  markers: Record<string, true>
}

export const completeBackgroundJobStore = Context.Service<
  SliceStoreService<CompleteBackgroundJobState, CompleteBackgroundJobState, unknown>
>("@ocpp/runtime/CompleteBackgroundJobStore")

export const createCompleteBackgroundJobState = (): CompleteBackgroundJobState => ({ markers: {} })

const backgroundStarted = sessionEvent("session-background-started")
const backgroundCompleted = sessionEvent("session-background-completed")

const input = Schema.toStandardSchemaV1(SessionFact.BackgroundCompleted.data)

export const completeBackgroundJob = implementCommand(specification)
  .inputSchema(input)
  .store(completeBackgroundJobStore)
  .consistencyKeys({ notification: (command) => command.notificationID })
  .apply(backgroundStarted, async (event, state) => {
    state.markers[event.payload.notificationID] = true
  })
  .apply(backgroundCompleted, async (event, state) => {
    delete state.markers[event.payload.notificationID]
  })
  .handle(async (command, state) => {
    if (!state.markers[command.notificationID])
      throw new CommandRejection("background-job-not-found", "Background job not found")
    return [backgroundCompleted.create(command)]
  })
