import { SessionEvent } from "@ocpp/schema/session-event"
import { SessionFact } from "@ocpp/schema/session-fact"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
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

// Rebuildable projection: every Session ID the log has named, live or deleted.
// Its Session lifecycle is the shared fold in session/lifecycle.ts. Which
// values the Session already stored is not folded: it would hold every
// instruction value ever recorded, and the host only stores what it has not
// stored.
export type UpdateInstructionsState = {
  sessions: Record<string, "live" | "deleted">
}

export const updateInstructionsStore = Context.Service<
  SliceStoreService<UpdateInstructionsState, UpdateInstructionsState, unknown>
>("@ocpp/runtime/UpdateInstructionsStore")

export const createUpdateInstructionsState = (): UpdateInstructionsState => ({ sessions: {} })

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
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, applySessionDeleted)
  .handle(async (command, state) => {
    const { blobs, ...update } = command
    requireLiveSession(state, update.sessionID)
    return [
      ...(blobs === undefined || Object.keys(blobs).length === 0
        ? []
        : [blobsStored.create({ sessionID: update.sessionID, blobs })]),
      instructionsUpdated.create(update),
    ]
  })
