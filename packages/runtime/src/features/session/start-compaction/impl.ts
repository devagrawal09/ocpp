import { SessionEvent } from "@ocpp/schema/session-event"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted. Duplicated in the other Session Slices on purpose. A compaction a
// stopped process left running does not block the next one: the next start
// supersedes it, as a new step supersedes a dead attempt's.
export type StartCompactionState = {
  sessions: Record<string, "live" | "deleted">
}

export const startCompactionStore = Context.Service<
  SliceStoreService<StartCompactionState, StartCompactionState, unknown>
>("@ocpp/runtime/StartCompactionStore")

export const createStartCompactionState = (): StartCompactionState => ({ sessions: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const compactionStarted = sessionEvent("session-compaction-started")

const input = Schema.toStandardSchemaV1(SessionEvent.Compaction.Started.data)

export const startCompaction = implementCommand(specification)
  .inputSchema(input)
  .store(startCompactionStore)
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
  })
  .handle(async (command, state) => {
    if (!state.sessions[command.sessionID]) throw new Error("Session not found")
    if (state.sessions[command.sessionID] === "deleted") throw new Error("Session deleted")
    return [compactionStarted.create(command)]
  })
