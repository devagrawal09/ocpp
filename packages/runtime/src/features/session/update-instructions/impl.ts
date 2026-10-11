import { SessionEvent } from "@ocpp/schema/session-event"
import { SessionFact } from "@ocpp/schema/session-fact"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted. Duplicated in the other Session Slices on purpose. Which values the
// Session already stored is not folded: it would hold every instruction value
// ever recorded, and the host only stores what it has not stored.
export type UpdateInstructionsState = {
  sessions: Record<string, "live" | "deleted">
}

export const updateInstructionsStore = Context.Service<
  SliceStoreService<UpdateInstructionsState, UpdateInstructionsState, unknown>
>("@ocpp/runtime/UpdateInstructionsStore")

export const createUpdateInstructionsState = (): UpdateInstructionsState => ({ sessions: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const instructionsUpdated = sessionEvent("session-instructions-updated")
const blobsStored = sessionEvent("session-instruction-blobs-stored")

const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    ...SessionEvent.InstructionsUpdated.data.fields,
    // The values the change introduces, by hash.
    blobs: Schema.optional(SessionFact.InstructionBlobsStored.data.fields.blobs),
  }),
)

export const updateInstructions = implementCommand(specification)
  .inputSchema(input)
  .store(updateInstructionsStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
  })
  .handle(async (command, state) => {
    const { blobs, ...update } = command
    if (!state.sessions[update.sessionID]) throw new Error("Session not found")
    if (state.sessions[update.sessionID] === "deleted") throw new Error("Session deleted")
    return [
      ...(blobs === undefined || Object.keys(blobs).length === 0
        ? []
        : [blobsStored.create({ sessionID: update.sessionID, blobs })]),
      instructionsUpdated.create(update),
    ]
  })
