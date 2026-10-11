import { Credential } from "@ocpp/schema/credential"
import type { IntegrationID } from "@ocpp/schema/integration-id"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: each credential's integration, and the credential
// each integration uses. Duplicated from the other credential Slices on
// purpose.
export type ActivateCredentialState = {
  credentials: Record<string, IntegrationID>
  active: Record<string, Credential.ID>
}

export const activateCredentialStore = Context.Service<
  SliceStoreService<ActivateCredentialState, ActivateCredentialState, unknown>
>("@ocpp/runtime/ActivateCredentialStore")

export const createActivateCredentialState = (): ActivateCredentialState => ({ credentials: {}, active: {} })

const credentialCreated = sessionEvent("credential-created")
const credentialActivated = sessionEvent("credential-activated")
const credentialRemoved = sessionEvent("credential-removed")

const input = Schema.toStandardSchemaV1(Schema.Struct({ credentialID: Credential.ID }))

export const activateCredential = implementCommand(specification)
  .inputSchema(input)
  .store(activateCredentialStore)
  .apply(credentialCreated, async (event, state) => {
    state.credentials[event.payload.credentialID] = event.payload.integrationID
    state.active[event.payload.integrationID] = event.payload.credentialID
  })
  .apply(credentialActivated, async (event, state) => {
    state.active[event.payload.integrationID] = event.payload.credentialID
  })
  .apply(credentialRemoved, async (event, state) => {
    const { credentialID, integrationID, replacement } = event.payload
    delete state.credentials[credentialID]
    if (replacement !== undefined) state.active[integrationID] = replacement
    else if (state.active[integrationID] === credentialID) delete state.active[integrationID]
  })
  .handle(async (command, state) => {
    const integrationID = state.credentials[command.credentialID]
    if (integrationID === undefined) throw new Error("Credential not found")
    if (state.active[integrationID] === command.credentialID) throw new Error("Credential already active")
    return [credentialActivated.create({ credentialID: command.credentialID, integrationID })]
  })
