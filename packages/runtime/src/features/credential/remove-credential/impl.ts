import { Credential } from "@ocpp/schema/credential"
import type { IntegrationID } from "@ocpp/schema/integration-id"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: each credential's integration, each integration's
// credentials in the order the log created them, and the credential each
// integration uses. Duplicated from the other credential Slices on purpose.
export type RemoveCredentialState = {
  credentials: Record<string, IntegrationID>
  integrations: Record<string, Credential.ID[]>
  active: Record<string, Credential.ID>
}

export const removeCredentialStore = Context.Service<
  SliceStoreService<RemoveCredentialState, RemoveCredentialState, unknown>
>("@ocpp/runtime/RemoveCredentialStore")

export const createRemoveCredentialState = (): RemoveCredentialState => ({
  credentials: {},
  integrations: {},
  active: {},
})

const credentialCreated = sessionEvent("credential-created")
const credentialActivated = sessionEvent("credential-activated")
const credentialRemoved = sessionEvent("credential-removed")

const input = Schema.toStandardSchemaV1(Schema.Struct({ credentialID: Credential.ID }))

export const removeCredential = implementCommand(specification)
  .inputSchema(input)
  .store(removeCredentialStore)
  // The credential's integration, whose one active credential the decision reads.
  .consistencyKeys((command, state) => {
    const integrationID = state.credentials[command.credentialID]
    return [command.credentialID, ...(integrationID === undefined ? [] : [integrationID])]
  })
  .apply(credentialCreated, async (event, state) => {
    const { credentialID, integrationID } = event.payload
    state.credentials[credentialID] = integrationID
    state.integrations[integrationID] = [...(state.integrations[integrationID] ?? []), credentialID]
    state.active[integrationID] = credentialID
  })
  .apply(credentialActivated, async (event, state) => {
    state.active[event.payload.integrationID] = event.payload.credentialID
  })
  .apply(credentialRemoved, async (event, state) => {
    const { credentialID, integrationID, replacement } = event.payload
    delete state.credentials[credentialID]
    const remaining = (state.integrations[integrationID] ?? []).filter((id) => id !== credentialID)
    if (remaining.length > 0) state.integrations[integrationID] = remaining
    else delete state.integrations[integrationID]
    if (replacement !== undefined) state.active[integrationID] = replacement
    else if (state.active[integrationID] === credentialID) delete state.active[integrationID]
  })
  .handle(async (command, state) => {
    const integrationID = state.credentials[command.credentialID]
    if (integrationID === undefined) throw new Error("Credential not found")
    // The newest of the integration's other credentials replaces the one it uses.
    const replacement =
      state.active[integrationID] === command.credentialID
        ? (state.integrations[integrationID] ?? []).filter((id) => id !== command.credentialID).at(-1)
        : undefined
    return [
      credentialRemoved.create({
        credentialID: command.credentialID,
        integrationID,
        ...(replacement === undefined ? {} : { replacement }),
      }),
    ]
  })
