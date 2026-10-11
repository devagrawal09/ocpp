import { Credential } from "@ocpp/schema/credential"
import { CredentialFact } from "@ocpp/schema/credential-fact"
import type { IntegrationID } from "@ocpp/schema/integration-id"
import { optional } from "@ocpp/schema/schema"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: each credential's integration and label.
// Duplicated from the other credential Slices on purpose.
export type UpdateCredentialState = {
  credentials: Record<string, { integrationID: IntegrationID; label: string }>
}

export const updateCredentialStore = Context.Service<
  SliceStoreService<UpdateCredentialState, UpdateCredentialState, unknown>
>("@ocpp/runtime/UpdateCredentialStore")

export const createUpdateCredentialState = (): UpdateCredentialState => ({ credentials: {} })

const credentialCreated = sessionEvent("credential-created")
const credentialRelabeled = sessionEvent("credential-relabeled")
const credentialRotated = sessionEvent("credential-rotated")
const credentialRemoved = sessionEvent("credential-removed")

const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    credentialID: Credential.ID,
    label: optional(Schema.String),
    // The new secret, sealed under the credential's key.
    secret: optional(CredentialFact.Sealed),
  }),
)

export const updateCredential = implementCommand(specification)
  .inputSchema(input)
  .store(updateCredentialStore)
  .consistencyKeys((command) => [command.credentialID])
  .apply(credentialCreated, async (event, state) => {
    state.credentials[event.payload.credentialID] = {
      integrationID: event.payload.integrationID,
      label: event.payload.label,
    }
  })
  .apply(credentialRelabeled, async (event, state) => {
    const credential = state.credentials[event.payload.credentialID]
    if (credential) credential.label = event.payload.label
  })
  .apply(credentialRemoved, async (event, state) => {
    delete state.credentials[event.payload.credentialID]
  })
  .handle(async (command, state) => {
    const credential = state.credentials[command.credentialID]
    if (!credential) throw new Error("Credential not found")
    const { credentialID } = command
    const integrationID = credential.integrationID
    const facts = [
      ...(command.label === undefined || command.label === credential.label
        ? []
        : [credentialRelabeled.create({ credentialID, integrationID, label: command.label })]),
      ...(command.secret === undefined
        ? []
        : [credentialRotated.create({ credentialID, integrationID, secret: command.secret })]),
    ]
    if (facts.length === 0) throw new Error("Credential unchanged")
    return facts
  })
