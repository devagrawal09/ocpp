import { SessionFact } from "@ocpp/schema/session-fact"
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
// and the commands each Session has, a fork's from its notebook copy. Its Session
// lifecycle is the shared fold in session/lifecycle.ts; the rest is duplicated
// from the other Code Mode command Slices on purpose.
export type RemoveCodeModeCommandState = {
  sessions: Record<string, "live" | "deleted">
  commands: Record<string, Record<string, true>>
}

export const removeCodeModeCommandStore = Context.Service<
  SliceStoreService<RemoveCodeModeCommandState, RemoveCodeModeCommandState, unknown>
>("@ocpp/runtime/RemoveCodeModeCommandStore")

export const createRemoveCodeModeCommandState = (): RemoveCodeModeCommandState => ({ sessions: {}, commands: {} })

const notebookCopied = sessionEvent("session-codemode-notebook-copied")
const defined = sessionEvent("session-codemode-command-defined")
const removed = sessionEvent("session-codemode-command-removed")

const input = Schema.toStandardSchemaV1(SessionFact.CommandRemoved.data)

export const removeCodeModeCommand = implementCommand(specification)
  .inputSchema(input)
  .store(removeCodeModeCommandStore, { stateVersion: 2 })
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
    delete state.commands[event.payload.sessionID]
  })
  // A fork's commands are those its notebook copy carries: the parent's whose handler it copied.
  .apply(notebookCopied, async (event, state) => {
    state.commands[event.payload.sessionID] = Object.fromEntries(
      Object.keys(event.payload.commands).map((name) => [name, true as const]),
    )
  })
  .apply(defined, async (event, state) => {
    ;(state.commands[event.payload.sessionID] ??= {})[event.payload.name] = true
  })
  .apply(removed, async (event, state) => {
    delete state.commands[event.payload.sessionID]?.[event.payload.name]
  })
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    if (!state.commands[command.sessionID]?.[command.name])
      throw new CommandRejection("command-not-found", "Command not found")
    return [removed.create(command)]
  })
