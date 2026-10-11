import { SessionEvent } from "@ocpp/schema/session-event"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted, and the executions whose Code Mode run settled. Duplicated from the
// other Code Mode lifecycle Slices on purpose.
export type SettleCodeModeState = {
  sessions: Record<string, "live" | "deleted">
  settled: Record<string, true>
}

export const settleCodeModeStore = Context.Service<
  SliceStoreService<SettleCodeModeState, SettleCodeModeState, unknown>
>("@ocpp/runtime/SettleCodeModeStore")

export const createSettleCodeModeState = (): SettleCodeModeState => ({ sessions: {}, settled: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const codeModeSettled = sessionEvent("session-codemode-settled")

const input = Schema.toStandardSchemaV1(SessionEvent.CodeMode.Settled.data)

export const settleCodeMode = implementCommand(specification)
  .inputSchema(input)
  .store(settleCodeModeStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
  })
  .apply(codeModeSettled, async (event, state) => {
    state.settled[event.payload.executionID] = true
  })
  .handle(async (command, state) => {
    const session = state.sessions[command.sessionID]
    if (!session) throw new Error("Session not found")
    if (session === "deleted") throw new Error("Session deleted")
    if (state.settled[command.executionID]) throw new Error("Code Mode already settled")
    return [codeModeSettled.create(command)]
  })
