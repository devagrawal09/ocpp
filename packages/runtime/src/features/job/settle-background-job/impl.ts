import { SessionFact } from "@ocpp/schema/session-fact"
import type { SessionID } from "@ocpp/schema/session-id"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import { forgetOwned, sessionDeleted } from "../../session/lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: the markers not yet completed, by notification,
// with the Session that owns each and whether its job runs. Duplicated from
// the other marker Slices on purpose.
export type SettleBackgroundJobState = {
  markers: Record<string, { sessionID: SessionID; status: "running" | "settled" }>
}

export const settleBackgroundJobStore = Context.Service<
  SliceStoreService<SettleBackgroundJobState, SettleBackgroundJobState, unknown>
>("@ocpp/runtime/SettleBackgroundJobStore")

export const createSettleBackgroundJobState = (): SettleBackgroundJobState => ({ markers: {} })

const backgroundStarted = sessionEvent("session-background-started")
const backgroundSettled = sessionEvent("session-background-settled")
const backgroundCompleted = sessionEvent("session-background-completed")

const { sessionID: _, ...outcome } = SessionFact.BackgroundSettled.data.fields
const input = Schema.toStandardSchemaV1(Schema.Struct(outcome))

export const settleBackgroundJob = implementCommand(specification)
  .inputSchema(input)
  .store(settleBackgroundJobStore, { stateVersion: 2 })
  // The marker's Session too, whose deletion forgets it.
  .consistencyKeys({
    notification: (command) => command.notificationID,
    session: (command, state) => state.markers[command.notificationID]?.sessionID,
  })
  .apply(backgroundStarted, async (event, state) => {
    state.markers[event.payload.notificationID] = { sessionID: event.payload.sessionID, status: "running" }
  })
  .apply(backgroundSettled, async (event, state) => {
    const marker = state.markers[event.payload.notificationID]
    if (marker) marker.status = "settled"
  })
  .apply(backgroundCompleted, async (event, state) => {
    delete state.markers[event.payload.notificationID]
  })
  // A deleted Session's markers go: its deletion completes them first, and a
  // fold that finds only its tombstone (the rest purged) forgets them by it.
  .apply(sessionDeleted, async (event, state) => {
    forgetOwned(event.payload.sessionID, state.markers)
  })
  .handle(async (command, state) => {
    const marker = state.markers[command.notificationID]
    if (!marker) throw new CommandRejection("background-job-not-found", "Background job not found")
    if (marker.status !== "running")
      throw new CommandRejection("background-job-not-running", "Background job not running")
    return [backgroundSettled.create({ ...command, sessionID: marker.sessionID })]
  })
