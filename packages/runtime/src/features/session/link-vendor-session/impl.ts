import { ExternalSession } from "@ocpp/schema/external-session"
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

// Rebuildable projection: every Session ID the log has named, live or deleted,
// and the vendor session each bound Session is linked to. Its Session
// lifecycle is the shared fold in session/lifecycle.ts; the rest is duplicated
// from the other external agent Slices on purpose.
export type LinkVendorSessionState = {
  sessions: Record<string, "live" | "deleted">
  bound: Record<string, { vendorSessionID?: string }>
}

export const linkVendorSessionStore = Context.Service<
  SliceStoreService<LinkVendorSessionState, LinkVendorSessionState, unknown>
>("@ocpp/runtime/LinkVendorSessionStore")

export const createLinkVendorSessionState = (): LinkVendorSessionState => ({ sessions: {}, bound: {} })

const externalBound = sessionEvent("session-external-bound")
const externalLinked = sessionEvent("session-external-linked")

const input = Schema.toStandardSchemaV1(ExternalSession.Linked.data)

export const linkVendorSession = implementCommand(specification)
  .inputSchema(input)
  .store(linkVendorSessionStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
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
    requireLiveSession(state, command.sessionID)
    const bound = state.bound[command.sessionID]
    if (!bound) throw new CommandRejection("external-agent-not-bound", "External agent not bound")
    if (bound.vendorSessionID === command.vendorSessionID)
      throw new CommandRejection("vendor-session-already-linked", "Vendor session already linked")
    return [externalLinked.create(command)]
  })
