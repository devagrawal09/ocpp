import { SessionEvent } from "@ocpp/schema/session-event"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applySessionCreated,
  applySessionDeleted,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
  type SessionsState,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session the log has named, live or deleted
// (the shared Session lifecycle), and each live Session's title.
export type RenameSessionState = SessionsState & { titles: Record<string, string> }

export const renameSessionStore = Context.Service<SliceStoreService<RenameSessionState, RenameSessionState, unknown>>(
  "@ocpp/runtime/RenameSessionStore",
)

export const createRenameSessionState = (): RenameSessionState => ({ sessions: {}, titles: {} })

const sessionRenamed = sessionEvent("session-renamed")

const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    ...SessionEvent.Renamed.data.fields,
    // A generated title: the title it was generated for (none, for an
    // untitled Session), which it replaces only while the Session has it.
    replacing: Schema.optional(Schema.Struct({ title: Schema.optional(Schema.String) })),
  }),
)

export const renameSession = implementCommand(specification)
  .inputSchema(input)
  .store(renameSessionStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, async (event, state) => {
    await applySessionCreated(event, state)
    if (event.payload.title !== undefined) state.titles[event.payload.sessionID] = event.payload.title
  })
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
    delete state.titles[event.payload.sessionID]
  })
  .apply(sessionRenamed, async (event, state) => {
    if (state.sessions[event.payload.sessionID]) state.titles[event.payload.sessionID] = event.payload.title
  })
  .handle(async (command, state) => {
    const { replacing, ...renamed } = command
    requireLiveSession(state, renamed.sessionID)
    if (replacing && state.titles[renamed.sessionID] !== replacing.title)
      throw new CommandRejection("title-changed", "Title changed")
    return [sessionRenamed.create(renamed)]
  })
