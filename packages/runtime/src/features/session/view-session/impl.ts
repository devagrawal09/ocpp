import { SessionEvent } from "@ocpp/schema/session-event"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applySessionCreated,
  applySessionDeleted,
  executionSettled,
  forgetSession,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
  type SessionsState,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session the log has named, live or deleted (the shared Session lifecycle); when
// each went idle, the time its execution last settled; and the newest idle time a viewer saw.
export type ViewSessionState = SessionsState & {
  idle: Record<string, number>
  viewed: Record<string, number>
}

export const viewSessionStore = Context.Service<SliceStoreService<ViewSessionState, ViewSessionState, unknown>>(
  "@ocpp/runtime/ViewSessionStore",
)

export const createViewSessionState = (): ViewSessionState => ({ sessions: {}, idle: {}, viewed: {} })

const sessionImported = sessionEvent("session-imported")
const sessionViewed = sessionEvent("session-viewed")

const input = Schema.toStandardSchemaV1(SessionEvent.Viewed.data)

export const viewSession = implementCommand(specification)
  .inputSchema(input)
  .store(viewSessionStore, { stateVersion: 2 })
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  // A deleted Session is forgotten but for its tombstone.
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
    forgetSession(event.payload.sessionID, state.idle, state.viewed)
  })
  // An import sets both as its export gave them.
  .apply(sessionImported, async (event, state) => {
    const { sessionID, time } = event.payload
    if (time.idle === undefined) delete state.idle[sessionID]
    else state.idle[sessionID] = time.idle
    if (time.viewed === undefined) delete state.viewed[sessionID]
    else state.viewed[sessionID] = time.viewed
  })
  .apply(executionSettled, async (event, state) => {
    const settled = event.payload
    // A shutdown is not the Session going idle: the next process resumes its execution.
    if (settled.outcome === "interrupted" && settled.reason === "shutdown") return
    // Every settlement advances the idle time, even within one millisecond, so a view of the last one is never
    // taken for a view of the next.
    const previous = state.idle[settled.sessionID]
    const time = Date.parse(event.recordedAt)
    state.idle[settled.sessionID] = previous === undefined ? time : Math.max(time, previous + 1)
  })
  .apply(sessionViewed, async (event, state) => {
    const { sessionID, idle } = event.payload
    state.viewed[sessionID] = Math.max(idle, state.viewed[sessionID] ?? idle)
  })
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    const idle = state.idle[command.sessionID]
    if (idle === undefined || command.idle > idle)
      throw new CommandRejection("idle-not-reached", "The Session has not gone idle at that time")
    if ((state.viewed[command.sessionID] ?? -1) >= command.idle)
      throw new CommandRejection("already-viewed", "Already viewed")
    return [sessionViewed.create(command)]
  })
