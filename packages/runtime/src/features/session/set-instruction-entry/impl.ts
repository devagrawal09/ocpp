import { SessionFact } from "@ocpp/schema/session-fact"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted, and each live Session's entries with their values as JSON. An
// entry's value is at most 8 KiB, and a Session holds a handful.
// Duplicated from remove-instruction-entry on purpose.
export type SetInstructionEntryState = {
  sessions: Record<string, "live" | "deleted">
  entries: Record<string, Record<string, string>>
}

export const setInstructionEntryStore = Context.Service<
  SliceStoreService<SetInstructionEntryState, SetInstructionEntryState, unknown>
>("@ocpp/runtime/SetInstructionEntryStore")

export const createSetInstructionEntryState = (): SetInstructionEntryState => ({ sessions: {}, entries: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const sessionForked = sessionEvent("session-forked")
const entrySet = sessionEvent("session-instruction-entry-set")
const entryRemoved = sessionEvent("session-instruction-entry-removed")

const input = Schema.toStandardSchemaV1(SessionFact.InstructionEntrySet.data)

export const setInstructionEntry = implementCommand(specification)
  .inputSchema(input)
  .store(setInstructionEntryStore)
  .consistencyKeys((command) => [command.sessionID])
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
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
    if (!state.sessions[command.sessionID]) throw new Error("Session not found")
    if (state.sessions[command.sessionID] === "deleted") throw new Error("Session deleted")
    if (state.entries[command.sessionID]?.[command.key] === JSON.stringify(command.value))
      throw new Error("Instruction entry unchanged")
    return [entrySet.create(command)]
  })
