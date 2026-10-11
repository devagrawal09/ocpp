import { SessionFact } from "@ocpp/schema/session-fact"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted, and the events each Session has, its fork's copies included.
// Duplicated from the other Code Mode event Slices on purpose.
export type SkipCodeModeEventState = {
  sessions: Record<string, "live" | "deleted">
  events: Record<string, Record<string, true>>
}

export const skipCodeModeEventStore = Context.Service<
  SliceStoreService<SkipCodeModeEventState, SkipCodeModeEventState, unknown>
>("@ocpp/runtime/SkipCodeModeEventStore")

export const createSkipCodeModeEventState = (): SkipCodeModeEventState => ({ sessions: {}, events: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const notebookCopied = sessionEvent("session-codemode-notebook-copied")
const defined = sessionEvent("session-codemode-event-defined")
const removed = sessionEvent("session-codemode-event-removed")
const recorded = sessionEvent("session-codemode-event-skipped")

const input = Schema.toStandardSchemaV1(SessionFact.EventSkipped.data)

export const skipCodeModeEvent = implementCommand(specification)
  .inputSchema(input)
  .store(skipCodeModeEventStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
    delete state.events[event.payload.sessionID]
  })
  // A fork's events are copied with its notebook; its projection drops those whose handler it lacks.
  .apply(notebookCopied, async (event, state) => {
    state.events[event.payload.sessionID] = { ...state.events[event.payload.parentID] }
  })
  .apply(defined, async (event, state) => {
    ;(state.events[event.payload.sessionID] ??= {})[event.payload.name] = true
  })
  .apply(removed, async (event, state) => {
    delete state.events[event.payload.sessionID]?.[event.payload.name]
  })
  .handle(async (command, state) => {
    const session = state.sessions[command.sessionID]
    if (!session) throw new CommandRejection("session-not-found", "Session not found")
    if (session === "deleted") throw new CommandRejection("session-deleted", "Session deleted")
    if (!state.events[command.sessionID]?.[command.name])
      throw new CommandRejection("event-not-found", "Event not found")
    return [recorded.create(command)]
  })
