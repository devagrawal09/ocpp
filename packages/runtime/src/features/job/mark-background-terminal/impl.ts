import { SessionFact } from "@ocpp/schema/session-fact"
import type { SessionID } from "@ocpp/schema/session-id"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import { sessionDeleted } from "../../session/lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: the markers not yet completed, by notification,
// with their job, the Session that owns them and whether they are terminal,
// and each marker by its job, since a Code Mode run's settlement names its
// job. Duplicated from the other marker Slices on purpose.
export type MarkBackgroundTerminalState = {
  markers: Record<string, { jobID: string; sessionID: SessionID; terminal: boolean }>
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

const { sessionID: _, ...marker } = SessionFact.BackgroundTerminal.data.fields
const input = Schema.toStandardSchemaV1(Schema.Struct(marker))

export const markBackgroundTerminal = implementCommand(specification)
  .inputSchema(input)
  .store(markBackgroundTerminalStore, { stateVersion: 2 })
  // The marker's job, whose Code Mode settlement makes it terminal, and its
  // Session, whose deletion forgets it.
  .consistencyKeys({
    notification: (command) => command.notificationID,
    execution: (command, state) => state.markers[command.notificationID]?.jobID,
    session: (command, state) => state.markers[command.notificationID]?.sessionID,
  })
  // A resumed job keeps its marker terminal.
  .apply(backgroundStarted, async (event, state) => {
    const { notificationID, jobID, sessionID } = event.payload
    state.markers[notificationID] = { jobID, sessionID, terminal: state.markers[notificationID]?.terminal ?? false }
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
  // A deleted Session's markers go: its deletion completes them first, and a
  // fold that finds only its tombstone (the rest purged) forgets them by it.
  .apply(sessionDeleted, async (event, state) => {
    for (const [notificationID, marker] of Object.entries(state.markers)) {
      if (marker.sessionID !== event.payload.sessionID) continue
      if (state.jobs[marker.jobID] === notificationID) delete state.jobs[marker.jobID]
      delete state.markers[notificationID]
    }
  })
  .handle(async (command, state) => {
    const marker = state.markers[command.notificationID]
    if (!marker) throw new CommandRejection("background-job-not-found", "Background job not found")
    if (marker.terminal)
      throw new CommandRejection("background-job-already-terminal", "Background job already terminal")
    return [backgroundTerminal.create({ ...command, sessionID: marker.sessionID })]
  })
