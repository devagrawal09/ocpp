import { SessionEvent } from "@ocpp/schema/session-event"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session the log has named, live or deleted,
// with its title. Duplicated from the other Session Slices on purpose.
export type RenameSessionState = {
  sessions: Record<string, { status: "live" | "deleted"; title?: string }>
}

export const renameSessionStore = Context.Service<SliceStoreService<RenameSessionState, RenameSessionState, unknown>>(
  "@ocpp/runtime/RenameSessionStore",
)

export const createRenameSessionState = (): RenameSessionState => ({ sessions: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
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
    const title = event.payload.title
    state.sessions[event.payload.sessionID] = { status: "live", ...(title === undefined ? {} : { title }) }
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = { status: "deleted" }
  })
  .apply(sessionRenamed, async (event, state) => {
    const session = state.sessions[event.payload.sessionID]
    if (session) session.title = event.payload.title
  })
  .handle(async (command, state) => {
    const { replacing, ...renamed } = command
    const session = state.sessions[renamed.sessionID]
    if (!session) throw new Error("Session not found")
    if (session.status === "deleted") throw new Error("Session deleted")
    if (replacing && session.title !== replacing.title) throw new Error("Title changed")
    return [sessionRenamed.create(renamed)]
  })
