import { ExternalSession } from "@ocpp/schema/external-session"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted, and the vendor session each bound Session is linked to. Duplicated
// from the other external agent Slices on purpose.
export type LinkVendorSessionState = {
  sessions: Record<string, "live" | "deleted">
  bound: Record<string, { vendorSessionID?: string }>
}

export const linkVendorSessionStore = Context.Service<
  SliceStoreService<LinkVendorSessionState, LinkVendorSessionState, unknown>
>("@ocpp/runtime/LinkVendorSessionStore")

export const createLinkVendorSessionState = (): LinkVendorSessionState => ({ sessions: {}, bound: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
const externalBound = sessionEvent("session-external-bound")
const externalLinked = sessionEvent("session-external-linked")

const input = Schema.toStandardSchemaV1(ExternalSession.Linked.data)

export const linkVendorSession = implementCommand(specification)
  .inputSchema(input)
  .store(linkVendorSessionStore)
  .consistencyKeys((command) => [command.sessionID])
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
    delete state.bound[event.payload.sessionID]
  })
  // Binding again starts a new vendor session.
  .apply(externalBound, async (event, state) => {
    state.bound[event.payload.sessionID] = {}
  })
  .apply(externalLinked, async (event, state) => {
    const bound = state.bound[event.payload.sessionID]
    if (bound) bound.vendorSessionID = event.payload.vendorSessionID
  })
  .handle(async (command, state) => {
    if (!state.sessions[command.sessionID]) throw new Error("Session not found")
    if (state.sessions[command.sessionID] === "deleted") throw new Error("Session deleted")
    const bound = state.bound[command.sessionID]
    if (!bound) throw new Error("External agent not bound")
    if (bound.vendorSessionID === command.vendorSessionID) throw new Error("Vendor session already linked")
    return [externalLinked.create(command)]
  })
