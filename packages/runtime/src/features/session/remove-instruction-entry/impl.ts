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
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or deleted,
// and the keys of each live Session's entries. Its Session lifecycle is the
// shared fold in session/lifecycle.ts; the rest is duplicated from set-
// instruction-entry on purpose.
export type RemoveInstructionEntryState = {
  sessions: Record<string, "live" | "deleted">
  keys: Record<string, Record<string, true>>
}

export const removeInstructionEntryStore = Context.Service<
  SliceStoreService<RemoveInstructionEntryState, RemoveInstructionEntryState, unknown>
>("@ocpp/runtime/RemoveInstructionEntryStore")

export const createRemoveInstructionEntryState = (): RemoveInstructionEntryState => ({ sessions: {}, keys: {} })

const sessionForked = sessionEvent("session-forked")
const entrySet = sessionEvent("session-instruction-entry-set")
const entryRemoved = sessionEvent("session-instruction-entry-removed")

const input = Schema.toStandardSchemaV1(SessionFact.InstructionEntryRemoved.data)

export const removeInstructionEntry = implementCommand(specification)
  .inputSchema(input)
  .store(removeInstructionEntryStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
    delete state.keys[event.payload.sessionID]
  })
  // A fork starts with its parent's entries, removed ones included.
  .apply(sessionForked, async (event, state) => {
    state.keys[event.payload.sessionID] = Object.fromEntries(
      (event.payload.instructionEntries ?? []).filter((entry) => !entry.removed).map((entry) => [entry.key, true]),
    )
  })
  .apply(entrySet, async (event, state) => {
    state.keys[event.payload.sessionID] = { ...state.keys[event.payload.sessionID], [event.payload.key]: true }
  })
  .apply(entryRemoved, async (event, state) => {
    delete state.keys[event.payload.sessionID]?.[event.payload.key]
  })
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    if (!state.keys[command.sessionID]?.[command.key])
      throw new CommandRejection("instruction-entry-not-found", "Instruction entry not found")
    return [entryRemoved.create(command)]
  })
