import { SessionFact } from "@ocpp/schema/session-fact"
import type { SessionID } from "@ocpp/schema/session-id"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import { forgetValued, sessionDeleted } from "../../session/lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: the markers not yet completed, by notification,
// with the Session that owns each. Duplicated from the other marker Slices on
// purpose.
export type CompleteBackgroundJobState = {
  markers: Record<string, SessionID>
}

export const completeBackgroundJobStore = Context.Service<
  SliceStoreService<CompleteBackgroundJobState, CompleteBackgroundJobState, unknown>
>("@ocpp/runtime/CompleteBackgroundJobStore")

export const createCompleteBackgroundJobState = (): CompleteBackgroundJobState => ({ markers: {} })

const backgroundStarted = sessionEvent("session-background-started")
const backgroundCompleted = sessionEvent("session-background-completed")

const { sessionID: _, ...marker } = SessionFact.BackgroundCompleted.data.fields
const input = Schema.toStandardSchemaV1(Schema.Struct(marker))

export const completeBackgroundJob = implementCommand(specification)
  .inputSchema(input)
  .store(completeBackgroundJobStore, { stateVersion: 2 })
  // The marker's Session too, whose deletion forgets it.
  .consistencyKeys({
    notification: (command) => command.notificationID,
    session: (command, state) => state.markers[command.notificationID],
  })
  .apply(backgroundStarted, async (event, state) => {
    state.markers[event.payload.notificationID] = event.payload.sessionID
  })
  .apply(backgroundCompleted, async (event, state) => {
    delete state.markers[event.payload.notificationID]
  })
  // A deleted Session's markers go: its deletion completes them first, and a
  // fold that finds only its tombstone (the rest purged) forgets them by it.
  .apply(sessionDeleted, async (event, state) => {
    forgetValued(event.payload.sessionID, state.markers)
  })
  .handle(async (command, state) => {
    const sessionID = state.markers[command.notificationID]
    if (sessionID === undefined) throw new CommandRejection("background-job-not-found", "Background job not found")
    return [backgroundCompleted.create({ ...command, sessionID })]
  })
