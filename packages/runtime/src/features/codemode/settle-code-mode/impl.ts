import { SessionEvent } from "@ocpp/schema/session-event"
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
// and the executions whose Code Mode run settled. Its Session lifecycle is the
// shared fold in session/lifecycle.ts; the rest is duplicated from the other
// Code Mode lifecycle Slices on purpose.
export type SettleCodeModeState = {
  sessions: Record<string, "live" | "deleted">
  settled: Record<string, true>
}

export const settleCodeModeStore = Context.Service<
  SliceStoreService<SettleCodeModeState, SettleCodeModeState, unknown>
>("@ocpp/runtime/SettleCodeModeStore")

export const createSettleCodeModeState = (): SettleCodeModeState => ({ sessions: {}, settled: {} })

const codeModeSettled = sessionEvent("session-codemode-settled")

const input = Schema.toStandardSchemaV1(SessionEvent.CodeMode.Settled.data)

export const settleCodeMode = implementCommand(specification)
  .inputSchema(input)
  .store(settleCodeModeStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, applySessionDeleted)
  .apply(codeModeSettled, async (event, state) => {
    state.settled[event.payload.executionID] = true
  })
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    if (state.settled[command.executionID])
      throw new CommandRejection("code-mode-already-settled", "Code Mode already settled")
    return [codeModeSettled.create(command)]
  })
