import { SessionFact } from "@ocpp/schema/session-fact"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: the markers not yet completed, by notification,
// and whether each one's job runs. Duplicated from the other marker Slices
// on purpose.
export type SettleBackgroundJobState = {
  markers: Record<string, "running" | "settled">
}

export const settleBackgroundJobStore = Context.Service<
  SliceStoreService<SettleBackgroundJobState, SettleBackgroundJobState, unknown>
>("@ocpp/runtime/SettleBackgroundJobStore")

export const createSettleBackgroundJobState = (): SettleBackgroundJobState => ({ markers: {} })

const backgroundStarted = sessionEvent("session-background-started")
const backgroundSettled = sessionEvent("session-background-settled")
const backgroundCompleted = sessionEvent("session-background-completed")

const input = Schema.toStandardSchemaV1(SessionFact.BackgroundSettled.data)

export const settleBackgroundJob = implementCommand(specification)
  .inputSchema(input)
  .store(settleBackgroundJobStore)
  .consistencyKeys((command) => [command.notificationID])
  .apply(backgroundStarted, async (event, state) => {
    state.markers[event.payload.notificationID] = "running"
  })
  .apply(backgroundSettled, async (event, state) => {
    if (state.markers[event.payload.notificationID]) state.markers[event.payload.notificationID] = "settled"
  })
  .apply(backgroundCompleted, async (event, state) => {
    delete state.markers[event.payload.notificationID]
  })
  .handle(async (command, state) => {
    const marker = state.markers[command.notificationID]
    if (!marker) throw new Error("Background job not found")
    if (marker !== "running") throw new Error("Background job not running")
    return [backgroundSettled.create(command)]
  })
