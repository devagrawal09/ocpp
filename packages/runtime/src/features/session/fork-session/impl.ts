import { SessionEvent } from "@ocpp/schema/session-event"
import { SessionID } from "@ocpp/schema/session-id"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted. Duplicated from create-session on purpose.
export type ForkSessionState = {
  sessions: Record<string, "live" | "deleted">
}

export const forkSessionStore = Context.Service<SliceStoreService<ForkSessionState, ForkSessionState, unknown>>(
  "@ocpp/runtime/ForkSessionStore",
)

export const createForkSessionState = (): ForkSessionState => ({ sessions: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const sessionForked = sessionEvent("session-forked")

// A fork is a Session of its own, not a child: it records where it came from
// in session-forked instead of a parent.
const { parentID: _parent, ...child } = SessionEvent.Created.data.fields
const { sessionID: _child, ...fork } = SessionEvent.Forked.data.fields

const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    session: Schema.Struct(child),
    ...fork,
    parentID: SessionID,
  }),
)

export const forkSession = implementCommand(specification)
  .inputSchema(input)
  .store(forkSessionStore)
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
  })
  .handle(async (command, state) => {
    if (!state.sessions[command.parentID]) throw new Error("Session not found")
    if (state.sessions[command.parentID] === "deleted") throw new Error("Session deleted")
    const sessionID = command.session.sessionID
    if (state.sessions[sessionID]) throw new Error("Session already exists")
    return [
      sessionCreated.create(command.session),
      sessionForked.create({
        sessionID,
        parentID: command.parentID,
        boundary: command.boundary,
        ...(command.instructions === undefined ? {} : { instructions: command.instructions }),
        ...(command.instructionEntries === undefined ? {} : { instructionEntries: command.instructionEntries }),
      }),
    ]
  })
