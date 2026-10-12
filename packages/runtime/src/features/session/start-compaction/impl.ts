import { SessionEvent } from "@ocpp/schema/session-event"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applySessionCreated,
  applySessionDeleted,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or deleted.
// Its Session lifecycle is the shared fold in session/lifecycle.ts. A
// compaction a stopped process left running does not block the next one: the
// next start supersedes it, as a new step supersedes a dead attempt's.
export type StartCompactionState = {
  sessions: Record<string, "live" | "deleted">
}

export const startCompactionStore = Context.Service<
  SliceStoreService<StartCompactionState, StartCompactionState, unknown>
>("@ocpp/runtime/StartCompactionStore")

export const createStartCompactionState = (): StartCompactionState => ({ sessions: {} })

const compactionStarted = sessionEvent("session-compaction-started")

const input = Schema.toStandardSchemaV1(SessionEvent.Compaction.Started.data)

export const startCompaction = implementCommand(specification)
  .inputSchema(input)
  .store(startCompactionStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, applySessionDeleted)
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    return [compactionStarted.create(command)]
  })
