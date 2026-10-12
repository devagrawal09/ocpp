import { SessionID } from "@ocpp/schema/session-id"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applyExecutionSettled,
  applyExecutionStarted,
  applySessionCreated,
  applySessionDeleted,
  executionSettled,
  executionStarted,
  forgetSession,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: known Sessions and whether each has an active
// execution (started, not yet succeeded/failed/interrupted). Its Session
// lifecycle is the shared fold in session/lifecycle.ts; the rest is duplicated
// from the other execution slices on purpose.
export type StartExecutionState = {
  sessions: Record<string, "live" | "deleted">
  active: Record<string, true>
}

export const startExecutionStore = Context.Service<
  SliceStoreService<StartExecutionState, StartExecutionState, unknown>
>("@ocpp/runtime/StartExecutionStore")

export const createStartExecutionState = (): StartExecutionState => ({
  sessions: {},
  active: {},
})

const executionContinued = sessionEvent("session-execution-continued")

const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    sessionID: SessionID,
    // Continue a turn the user interrupted: steering input and control items
    // only.
    continues: Schema.optional(Schema.Boolean),
  }),
)

export const startExecution = implementCommand(specification)
  .inputSchema(input)
  .store(startExecutionStore, { stateVersion: 2 })
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  // A deleted Session is forgotten but for its tombstone.
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
    forgetSession(event.payload.sessionID, state.active)
  })
  .apply(executionStarted, applyExecutionStarted)
  .apply(executionSettled, applyExecutionSettled)
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    if (state.active[command.sessionID])
      throw new CommandRejection("execution-already-active", "Execution already active")
    return [
      executionStarted.create({ sessionID: command.sessionID }),
      ...(command.continues ? [executionContinued.create({ sessionID: command.sessionID })] : []),
    ]
  })
