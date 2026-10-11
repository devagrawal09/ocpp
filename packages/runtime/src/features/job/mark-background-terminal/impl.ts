import { SessionFact } from "@ocpp/schema/session-fact"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: the markers not yet completed, by notification,
// with their job and whether they are terminal, and each marker by its job,
// since a Code Mode run's settlement names its job. Duplicated from the
// other marker Slices on purpose.
export type MarkBackgroundTerminalState = {
  markers: Record<string, { jobID: string; terminal: boolean }>
  jobs: Record<string, string>
}

export const markBackgroundTerminalStore = Context.Service<
  SliceStoreService<MarkBackgroundTerminalState, MarkBackgroundTerminalState, unknown>
>("@ocpp/runtime/MarkBackgroundTerminalStore")

export const createMarkBackgroundTerminalState = (): MarkBackgroundTerminalState => ({ markers: {}, jobs: {} })

const backgroundStarted = sessionEvent("session-background-started")
const backgroundTerminal = sessionEvent("session-background-terminal")
const backgroundCompleted = sessionEvent("session-background-completed")
const codemodeSettled = sessionEvent("session-codemode-settled")

const input = Schema.toStandardSchemaV1(SessionFact.BackgroundTerminal.data)

export const markBackgroundTerminal = implementCommand(specification)
  .inputSchema(input)
  .store(markBackgroundTerminalStore)
  // The marker's job, whose Code Mode settlement makes it terminal.
  .consistencyKeys({
    notification: (command) => command.notificationID,
    execution: (command, state) => state.markers[command.notificationID]?.jobID,
  })
  // A resumed job keeps its marker terminal.
  .apply(backgroundStarted, async (event, state) => {
    const { notificationID, jobID } = event.payload
    state.markers[notificationID] = { jobID, terminal: state.markers[notificationID]?.terminal ?? false }
    state.jobs[jobID] = notificationID
  })
  .apply(backgroundTerminal, async (event, state) => {
    const marker = state.markers[event.payload.notificationID]
    if (marker) marker.terminal = true
  })
  .apply(codemodeSettled, async (event, state) => {
    const notificationID = state.jobs[event.payload.executionID]
    const marker = notificationID === undefined ? undefined : state.markers[notificationID]
    if (marker) marker.terminal = true
  })
  .apply(backgroundCompleted, async (event, state) => {
    const marker = state.markers[event.payload.notificationID]
    if (marker && state.jobs[marker.jobID] === event.payload.notificationID) delete state.jobs[marker.jobID]
    delete state.markers[event.payload.notificationID]
  })
  .handle(async (command, state) => {
    const marker = state.markers[command.notificationID]
    if (!marker) throw new CommandRejection("background-job-not-found", "Background job not found")
    if (marker.terminal)
      throw new CommandRejection("background-job-already-terminal", "Background job already terminal")
    return [backgroundTerminal.create(command)]
  })
