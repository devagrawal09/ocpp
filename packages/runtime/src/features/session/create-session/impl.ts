import { SessionEvent } from "@ocpp/schema/session-event"
import { SessionFact } from "@ocpp/schema/session-fact"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted. Duplicated in the other Session Slices on purpose.
export type CreateSessionState = {
  sessions: Record<string, "live" | "deleted">
}

export const createSessionStore = Context.Service<SliceStoreService<CreateSessionState, CreateSessionState, unknown>>(
  "@ocpp/runtime/CreateSessionStore",
)

export const createCreateSessionState = (): CreateSessionState => ({ sessions: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const sessionImported = sessionEvent("session-imported")

const { sessionID: _, ...imported } = SessionFact.Imported.data.fields

const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    // What session-created records: the host chooses the ID, slug and the
    // rest, so the decision stays a function of the log.
    session: SessionEvent.Created.data,
    // A Session imported from another server's export: its settled messages
    // and what it had used, recorded with its creation.
    imported: Schema.optional(Schema.Struct(imported)),
  }),
)

export const createSession = implementCommand(specification)
  .inputSchema(input)
  .store(createSessionStore)
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
  })
  .handle(async (command, state) => {
    const sessionID = command.session.sessionID
    if (state.sessions[sessionID] === "deleted") throw new Error("Session deleted")
    if (state.sessions[sessionID]) throw new Error("Session already exists")
    const parentID = command.session.parentID
    if (parentID !== undefined && !state.sessions[parentID]) throw new Error("Parent session not found")
    if (parentID !== undefined && state.sessions[parentID] === "deleted") throw new Error("Parent session deleted")
    return [
      sessionCreated.create(command.session),
      ...(command.imported === undefined ? [] : [sessionImported.create({ sessionID, ...command.imported })]),
    ]
  })
