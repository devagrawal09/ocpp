import { SessionEvent } from "@ocpp/schema/session-event"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted, and the shells each live Session has run. Duplicated from
// settle-shell on purpose.
export type RunShellState = {
  sessions: Record<string, "live" | "deleted">
  shells: Record<string, Record<string, "running" | "settled">>
}

export const runShellStore =
  Context.Service<SliceStoreService<RunShellState, RunShellState, unknown>>("@ocpp/runtime/RunShellStore")

export const createRunShellState = (): RunShellState => ({ sessions: {}, shells: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const shellStarted = sessionEvent("session-shell-started")
const shellSettled = sessionEvent("session-shell-settled")

const input = Schema.toStandardSchemaV1(SessionEvent.Shell.Started.data)

export const runShell = implementCommand(specification)
  .inputSchema(input)
  .store(runShellStore)
  .consistencyKeys((command) => [command.sessionID])
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
    delete state.shells[event.payload.sessionID]
  })
  .apply(shellStarted, async (event, state) => {
    const { sessionID, shell } = event.payload
    state.shells[sessionID] = { ...state.shells[sessionID], [shell.id]: "running" }
  })
  .apply(shellSettled, async (event, state) => {
    const shells = state.shells[event.payload.sessionID]
    if (shells?.[event.payload.shellID]) shells[event.payload.shellID] = "settled"
  })
  .handle(async (command, state) => {
    if (!state.sessions[command.sessionID]) throw new Error("Session not found")
    if (state.sessions[command.sessionID] === "deleted") throw new Error("Session deleted")
    if (state.shells[command.sessionID]?.[command.shell.id]) throw new Error("Shell already started")
    return [shellStarted.create(command)]
  })
