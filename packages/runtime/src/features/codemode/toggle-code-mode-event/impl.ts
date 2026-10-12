import { SessionFact } from "@ocpp/schema/session-fact"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applySessionCreated,
  applySessionDeleted,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
} from "../../session/lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or deleted,
// and the events each Session has, its fork's copies included. Its Session
// lifecycle is the shared fold in session/lifecycle.ts; the rest is duplicated
// from the other Code Mode event Slices on purpose.
export type ToggleCodeModeEventState = {
  sessions: Record<string, "live" | "deleted">
  events: Record<string, Record<string, true>>
}

export const toggleCodeModeEventStore = Context.Service<
  SliceStoreService<ToggleCodeModeEventState, ToggleCodeModeEventState, unknown>
>("@ocpp/runtime/ToggleCodeModeEventStore")

export const createToggleCodeModeEventState = (): ToggleCodeModeEventState => ({ sessions: {}, events: {} })

const notebookCopied = sessionEvent("session-codemode-notebook-copied")
const defined = sessionEvent("session-codemode-event-defined")
const removed = sessionEvent("session-codemode-event-removed")
const recorded = sessionEvent("session-codemode-event-toggled")

const input = Schema.toStandardSchemaV1(SessionFact.EventToggled.data)

export const toggleCodeModeEvent = implementCommand(specification)
  .inputSchema(input)
  .store(toggleCodeModeEventStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
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
    requireLiveSession(state, command.sessionID)
    if (!state.events[command.sessionID]?.[command.name])
      throw new CommandRejection("event-not-found", "Event not found")
    return [recorded.create(command)]
  })
