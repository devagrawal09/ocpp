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
// and each live Session's entries with their values as JSON. An entry's value
// is at most 8 KiB, and a Session holds a handful. Its Session lifecycle is
// the shared fold in session/lifecycle.ts; the rest is duplicated from remove-
// instruction-entry on purpose.
export type SetInstructionEntryState = {
  sessions: Record<string, "live" | "deleted">
  entries: Record<string, Record<string, string>>
}

export const setInstructionEntryStore = Context.Service<
  SliceStoreService<SetInstructionEntryState, SetInstructionEntryState, unknown>
>("@ocpp/runtime/SetInstructionEntryStore")

export const createSetInstructionEntryState = (): SetInstructionEntryState => ({ sessions: {}, entries: {} })

const sessionForked = sessionEvent("session-forked")
const entrySet = sessionEvent("session-instruction-entry-set")
const entryRemoved = sessionEvent("session-instruction-entry-removed")

const input = Schema.toStandardSchemaV1(SessionFact.InstructionEntrySet.data)

export const setInstructionEntry = implementCommand(specification)
  .inputSchema(input)
  .store(setInstructionEntryStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
    delete state.entries[event.payload.sessionID]
  })
  // A fork starts with its parent's entries, removed ones included.
  .apply(sessionForked, async (event, state) => {
    state.entries[event.payload.sessionID] = Object.fromEntries(
      (event.payload.instructionEntries ?? [])
        .filter((entry) => !entry.removed)
        .map((entry) => [entry.key, JSON.stringify(entry.value)]),
    )
  })
  .apply(entrySet, async (event, state) => {
    const { sessionID, key, value } = event.payload
    state.entries[sessionID] = { ...state.entries[sessionID], [key]: JSON.stringify(value) }
  })
  .apply(entryRemoved, async (event, state) => {
    delete state.entries[event.payload.sessionID]?.[event.payload.key]
  })
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    if (state.entries[command.sessionID]?.[command.key] === JSON.stringify(command.value))
      throw new CommandRejection("instruction-entry-unchanged", "Instruction entry unchanged")
    return [entrySet.create(command)]
  })
