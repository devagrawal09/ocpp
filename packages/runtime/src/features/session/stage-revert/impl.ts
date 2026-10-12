import { SessionID } from "@ocpp/schema/session-id"
import { Revert } from "@ocpp/schema/session-revert"
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
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or deleted,
// and the Sessions with an active execution. Its Session lifecycle is the
// shared fold in session/lifecycle.ts; the rest is duplicated from the other
// revert Slices on purpose.
export type StageRevertState = {
  sessions: Record<string, "live" | "deleted">
  active: Record<string, true>
}

export const stageRevertStore = Context.Service<SliceStoreService<StageRevertState, StageRevertState, unknown>>(
  "@ocpp/runtime/StageRevertStore",
)

export const createStageRevertState = (): StageRevertState => ({ sessions: {}, active: {} })

const revertStaged = sessionEvent("session-revert-staged")

const input = Schema.toStandardSchemaV1(Schema.Struct({ sessionID: SessionID, revert: Revert }))

export const stageRevert = implementCommand(specification)
  .inputSchema(input)
  .store(stageRevertStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, applySessionDeleted)
  .apply(executionStarted, applyExecutionStarted)
  .apply(executionSettled, applyExecutionSettled)
  // Deliberately a no-op: a stage replaces whatever was staged, so the
  // scenario that stages twice needs no state.
  .apply(revertStaged, async () => {})
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    if (state.active[command.sessionID]) throw new CommandRejection("session-busy", "Session is busy")
    return [revertStaged.create({ sessionID: command.sessionID, revert: command.revert })]
  })
