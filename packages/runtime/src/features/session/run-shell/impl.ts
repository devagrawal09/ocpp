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
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or deleted,
// and the shells each live Session has run. Its Session lifecycle is the
// shared fold in session/lifecycle.ts; the rest is duplicated from settle-
// shell on purpose.
export type RunShellState = {
  sessions: Record<string, "live" | "deleted">
  shells: Record<string, Record<string, "running" | "settled">>
}

export const runShellStore =
  Context.Service<SliceStoreService<RunShellState, RunShellState, unknown>>("@ocpp/runtime/RunShellStore")

export const createRunShellState = (): RunShellState => ({ sessions: {}, shells: {} })

const shellStarted = sessionEvent("session-shell-started")
const shellSettled = sessionEvent("session-shell-settled")

const input = Schema.toStandardSchemaV1(SessionEvent.Shell.Started.data)

export const runShell = implementCommand(specification)
  .inputSchema(input)
  .store(runShellStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
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
    requireLiveSession(state, command.sessionID)
    if (state.shells[command.sessionID]?.[command.shell.id])
      throw new CommandRejection("shell-already-started", "Shell already started")
    return [shellStarted.create(command)]
  })
