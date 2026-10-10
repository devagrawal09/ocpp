import { SessionFact } from "@ocpp/schema/session-fact"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted, and the keys of each live Session's entries. Duplicated from
// set-instruction-entry on purpose.
export type RemoveInstructionEntryState = {
  sessions: Record<string, "live" | "deleted">
  keys: Record<string, Record<string, true>>
}

export const removeInstructionEntryStore = Context.Service<
  SliceStoreService<RemoveInstructionEntryState, RemoveInstructionEntryState, unknown>
>("@ocpp/runtime/RemoveInstructionEntryStore")

export const createRemoveInstructionEntryState = (): RemoveInstructionEntryState => ({ sessions: {}, keys: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const sessionForked = sessionEvent("session-forked")
const entrySet = sessionEvent("session-instruction-entry-set")
const entryRemoved = sessionEvent("session-instruction-entry-removed")

const input = Schema.toStandardSchemaV1(SessionFact.InstructionEntryRemoved.data)

export const removeInstructionEntry = implementCommand(specification)
  .inputSchema(input)
  .store(removeInstructionEntryStore)
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
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
    if (!state.sessions[command.sessionID]) throw new Error("Session not found")
    if (state.sessions[command.sessionID] === "deleted") throw new Error("Session deleted")
    if (!state.keys[command.sessionID]?.[command.key]) throw new Error("Instruction entry not found")
    return [entryRemoved.create(command)]
  })
