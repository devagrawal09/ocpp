import { SessionError } from "@ocpp/schema/session-error"
import { SessionID } from "@ocpp/schema/session-id"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import {
  applyExecutionSettled,
  applyExecutionStarted,
  executionSettled,
  executionStarted,
  forgetSession,
  sessionDeleted,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: active executions. Its Session lifecycle is the
// shared fold in session/lifecycle.ts; the rest is duplicated on purpose.
export type FailExecutionState = { active: Record<string, true> }

export const failExecutionStore = Context.Service<SliceStoreService<FailExecutionState, FailExecutionState, unknown>>(
  "@ocpp/runtime/FailExecutionStore",
)

export const createFailExecutionState = (): FailExecutionState => ({
  active: {},
})

const input = Schema.toStandardSchemaV1(Schema.Struct({ sessionID: SessionID, error: SessionError.Error }))

// Fails the busy period for a reason outside a step (a manual or automatic
// compaction that failed). A step's own failure is settleStep's.
export const failExecution = implementCommand(specification)
  .inputSchema(input)
  .store(failExecutionStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(executionStarted, applyExecutionStarted)
  .apply(executionSettled, applyExecutionSettled)
  // A deleted Session's execution was settled first; a fold that finds only
  // its tombstone (the rest purged) forgets it by that.
  .apply(sessionDeleted, async (event, state) => {
    forgetSession(event.payload.sessionID, state.active)
  })
  .handle(async (command, state) => {
    if (!state.active[command.sessionID]) throw new CommandRejection("execution-not-active", "Execution not active")
    return [
      executionSettled.create({
        sessionID: command.sessionID,
        outcome: "failed",
        error: command.error,
      }),
    ]
  })
