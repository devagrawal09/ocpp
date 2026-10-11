import { SessionEvent } from "@ocpp/schema/session-event"
import { optional } from "@ocpp/schema/schema"
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
const notebookCopied = sessionEvent("session-codemode-notebook-copied")

// A fork is a Session of its own, not a child: it records where it came from
// in session-forked instead of a parent.
const { parentID: _parent, ...child } = SessionEvent.Created.data.fields
const { sessionID: _child, ...fork } = SessionEvent.Forked.data.fields

const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    session: Schema.Struct(child),
    ...fork,
    parentID: SessionID,
    // The parent's Code Mode executions whose saved values the fork copies: those its history copies through
    // the boundary, as the host resolves them.
    notebook: optional(Schema.Array(Schema.String)),
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
    // The child's notebook comes before the fork, whose projection checkpoints it in the child's instructions.
    return [
      sessionCreated.create(command.session),
      ...(command.notebook === undefined || command.notebook.length === 0
        ? []
        : [notebookCopied.create({ sessionID, parentID: command.parentID, executions: command.notebook })]),
      sessionForked.create({
        sessionID,
        parentID: command.parentID,
        boundary: command.boundary,
        ...(command.instructions === undefined ? {} : { instructions: command.instructions }),
        ...(command.instructionEntries === undefined ? {} : { instructionEntries: command.instructionEntries }),
      }),
    ]
  })
