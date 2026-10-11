import { SessionID } from "@ocpp/schema/session-id"
import { Revert } from "@ocpp/schema/session-revert"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted, and the Sessions with an active execution. Duplicated from the
// other revert Slices on purpose.
export type StageRevertState = {
  sessions: Record<string, "live" | "deleted">
  active: Record<string, true>
}

export const stageRevertStore = Context.Service<SliceStoreService<StageRevertState, StageRevertState, unknown>>(
  "@ocpp/runtime/StageRevertStore",
)

export const createStageRevertState = (): StageRevertState => ({ sessions: {}, active: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const executionStarted = sessionEvent("session-execution-started")
const executionSettled = sessionEvent("session-execution-settled")
const revertStaged = sessionEvent("session-revert-staged")

const input = Schema.toStandardSchemaV1(Schema.Struct({ sessionID: SessionID, revert: Revert }))

export const stageRevert = implementCommand(specification)
  .inputSchema(input)
  .store(stageRevertStore)
  .consistencyKeys((command) => [command.sessionID])
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
  })
  .apply(executionStarted, async (event, state) => {
    state.active[event.payload.sessionID] = true
  })
  .apply(executionSettled, async (event, state) => {
    delete state.active[event.payload.sessionID]
  })
  // Deliberately a no-op: a stage replaces whatever was staged, so the
  // scenario that stages twice needs no state.
  .apply(revertStaged, async () => {})
  .handle(async (command, state) => {
    if (!state.sessions[command.sessionID]) throw new Error("Session not found")
    if (state.sessions[command.sessionID] === "deleted") throw new Error("Session deleted")
    if (state.active[command.sessionID]) throw new Error("Session is busy")
    return [revertStaged.create({ sessionID: command.sessionID, revert: command.revert })]
  })
