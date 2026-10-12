import { ExternalSession } from "@ocpp/schema/external-session"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
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

// Rebuildable projection: every Session ID the log has named, live or deleted,
// and the Sessions bound to an external agent. Its Session lifecycle is the
// shared fold in session/lifecycle.ts; the rest is duplicated from the other
// external agent Slices on purpose.
export type CheckpointVendorSessionState = {
  sessions: Record<string, "live" | "deleted">
  bound: Record<string, true>
}

export const checkpointVendorSessionStore = Context.Service<
  SliceStoreService<CheckpointVendorSessionState, CheckpointVendorSessionState, unknown>
>("@ocpp/runtime/CheckpointVendorSessionStore")

export const createCheckpointVendorSessionState = (): CheckpointVendorSessionState => ({ sessions: {}, bound: {} })

const externalBound = sessionEvent("session-external-bound")
const externalCheckpointed = sessionEvent("session-external-checkpointed")

const input = Schema.toStandardSchemaV1(ExternalSession.Checkpointed.data)

export const checkpointVendorSession = implementCommand(specification)
  .inputSchema(input)
  .store(checkpointVendorSessionStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
    delete state.bound[event.payload.sessionID]
  })
  .apply(externalBound, async (event, state) => {
    state.bound[event.payload.sessionID] = true
  })
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    if (!state.bound[command.sessionID])
      throw new CommandRejection("external-agent-not-bound", "External agent not bound")
    return [externalCheckpointed.create(command)]
  })
