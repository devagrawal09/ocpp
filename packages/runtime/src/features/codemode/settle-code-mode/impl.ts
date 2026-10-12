import { SessionEvent } from "@ocpp/schema/session-event"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applySessionCreated,
  applySessionDeleted,
  forgetValued,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
} from "../../session/lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or deleted,
// and the executions whose Code Mode run settled, with their Session. Its
// Session lifecycle is the shared fold in session/lifecycle.ts; the rest is
// duplicated from the other Code Mode lifecycle Slices on purpose.
export type SettleCodeModeState = {
  sessions: Record<string, "live" | "deleted">
  settled: Record<string, string>
}

export const settleCodeModeStore = Context.Service<
  SliceStoreService<SettleCodeModeState, SettleCodeModeState, unknown>
>("@ocpp/runtime/SettleCodeModeStore")

export const createSettleCodeModeState = (): SettleCodeModeState => ({ sessions: {}, settled: {} })

const codeModeSettled = sessionEvent("session-codemode-settled")

const input = Schema.toStandardSchemaV1(SessionEvent.CodeMode.Settled.data)

export const settleCodeMode = implementCommand(specification)
  .inputSchema(input)
  .store(settleCodeModeStore, { stateVersion: 2 })
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  // A deleted Session is forgotten but for its tombstone.
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
    forgetValued(event.payload.sessionID, state.settled)
  })
  .apply(codeModeSettled, async (event, state) => {
    state.settled[event.payload.executionID] = event.payload.sessionID
  })
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    if (state.settled[command.executionID])
      throw new CommandRejection("code-mode-already-settled", "Code Mode already settled")
    return [codeModeSettled.create(command)]
  })
