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
// and the events each Session has, a fork's from its notebook copy. Its Session
// lifecycle is the shared fold in session/lifecycle.ts; the rest is duplicated
// from the other Code Mode event Slices on purpose.
export type FireCodeModeEventState = {
  sessions: Record<string, "live" | "deleted">
  events: Record<string, Record<string, true>>
}

export const fireCodeModeEventStore = Context.Service<
  SliceStoreService<FireCodeModeEventState, FireCodeModeEventState, unknown>
>("@ocpp/runtime/FireCodeModeEventStore")

export const createFireCodeModeEventState = (): FireCodeModeEventState => ({ sessions: {}, events: {} })

const notebookCopied = sessionEvent("session-codemode-notebook-copied")
const defined = sessionEvent("session-codemode-event-defined")
const removed = sessionEvent("session-codemode-event-removed")
const recorded = sessionEvent("session-codemode-event-fired")

const input = Schema.toStandardSchemaV1(SessionFact.EventFired.data)

export const fireCodeModeEvent = implementCommand(specification)
  .inputSchema(input)
  .store(fireCodeModeEventStore, { stateVersion: 2 })
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
    delete state.events[event.payload.sessionID]
  })
  // A fork's events are those its notebook copy carries: the parent's whose handler it copied.
  .apply(notebookCopied, async (event, state) => {
    state.events[event.payload.sessionID] = Object.fromEntries(
      Object.keys(event.payload.events).map((name) => [name, true as const]),
    )
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
