import { SessionEvent } from "@ocpp/schema/session-event"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted, and the shells each live Session runs. Duplicated from run-shell
// on purpose.
export type SettleShellState = {
  sessions: Record<string, "live" | "deleted">
  running: Record<string, Record<string, true>>
}

export const settleShellStore = Context.Service<SliceStoreService<SettleShellState, SettleShellState, unknown>>(
  "@ocpp/runtime/SettleShellStore",
)

export const createSettleShellState = (): SettleShellState => ({ sessions: {}, running: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const shellStarted = sessionEvent("session-shell-started")
const shellSettled = sessionEvent("session-shell-settled")

const input = Schema.toStandardSchemaV1(SessionEvent.Shell.Settled.data)

export const settleShell = implementCommand(specification)
  .inputSchema(input)
  .store(settleShellStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
    delete state.running[event.payload.sessionID]
  })
  .apply(shellStarted, async (event, state) => {
    const { sessionID, shell } = event.payload
    state.running[sessionID] = { ...state.running[sessionID], [shell.id]: true }
  })
  .apply(shellSettled, async (event, state) => {
    delete state.running[event.payload.sessionID]?.[event.payload.shellID]
  })
  .handle(async (command, state) => {
    if (!state.sessions[command.sessionID]) throw new CommandRejection("session-not-found", "Session not found")
    if (state.sessions[command.sessionID] === "deleted")
      throw new CommandRejection("session-deleted", "Session deleted")
    if (!state.running[command.sessionID]?.[command.shellID])
      throw new CommandRejection("shell-not-running", "Shell not running")
    return [shellSettled.create(command)]
  })
