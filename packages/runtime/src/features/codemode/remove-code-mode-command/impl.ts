import { SessionFact } from "@ocpp/schema/session-fact"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted, and the commands each Session has, its fork's copies included.
// Duplicated from the other Code Mode command Slices on purpose.
export type RemoveCodeModeCommandState = {
  sessions: Record<string, "live" | "deleted">
  commands: Record<string, Record<string, true>>
}

export const removeCodeModeCommandStore = Context.Service<
  SliceStoreService<RemoveCodeModeCommandState, RemoveCodeModeCommandState, unknown>
>("@ocpp/runtime/RemoveCodeModeCommandStore")

export const createRemoveCodeModeCommandState = (): RemoveCodeModeCommandState => ({ sessions: {}, commands: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const notebookCopied = sessionEvent("session-codemode-notebook-copied")
const defined = sessionEvent("session-codemode-command-defined")
const removed = sessionEvent("session-codemode-command-removed")

const input = Schema.toStandardSchemaV1(SessionFact.CommandRemoved.data)

export const removeCodeModeCommand = implementCommand(specification)
  .inputSchema(input)
  .store(removeCodeModeCommandStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
    delete state.commands[event.payload.sessionID]
  })
  // A fork's commands are copied with its notebook; its projection drops those whose handler it lacks.
  .apply(notebookCopied, async (event, state) => {
    state.commands[event.payload.sessionID] = { ...state.commands[event.payload.parentID] }
  })
  .apply(defined, async (event, state) => {
    ;(state.commands[event.payload.sessionID] ??= {})[event.payload.name] = true
  })
  .apply(removed, async (event, state) => {
    delete state.commands[event.payload.sessionID]?.[event.payload.name]
  })
  .handle(async (command, state) => {
    const session = state.sessions[command.sessionID]
    if (!session) throw new CommandRejection("session-not-found", "Session not found")
    if (session === "deleted") throw new CommandRejection("session-deleted", "Session deleted")
    if (!state.commands[command.sessionID]?.[command.name])
      throw new CommandRejection("command-not-found", "Command not found")
    return [removed.create(command)]
  })
