import { SessionEvent } from "@ocpp/schema/session-event"
import { optional } from "@ocpp/schema/schema"
import { SessionID } from "@ocpp/schema/session-id"
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

// Rebuildable projection: every Session ID the log has named, live or deleted.
// Its Session lifecycle is the shared fold in session/lifecycle.ts; the rest
// is duplicated from create-session on purpose.
export type ForkSessionState = {
  sessions: Record<string, "live" | "deleted">
}

export const forkSessionStore = Context.Service<SliceStoreService<ForkSessionState, ForkSessionState, unknown>>(
  "@ocpp/runtime/ForkSessionStore",
)

export const createForkSessionState = (): ForkSessionState => ({ sessions: {} })

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
  // The parent is a Session the decision reads.
  .consistencyKeys({ session: (command) => [command.session.sessionID, command.parentID] })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, applySessionDeleted)
  .handle(async (command, state) => {
    requireLiveSession(state, command.parentID)
    const sessionID = command.session.sessionID
    if (state.sessions[sessionID]) throw new CommandRejection("session-already-exists", "Session already exists")
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
