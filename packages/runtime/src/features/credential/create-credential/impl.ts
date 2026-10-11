import { CredentialFact } from "@ocpp/schema/credential-fact"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: the credentials that exist.
export type CreateCredentialState = {
  credentials: Record<string, true>
}

export const createCredentialStore = Context.Service<
  SliceStoreService<CreateCredentialState, CreateCredentialState, unknown>
>("@ocpp/runtime/CreateCredentialStore")

export const createCreateCredentialState = (): CreateCredentialState => ({ credentials: {} })

const credentialCreated = sessionEvent("credential-created")
const credentialRemoved = sessionEvent("credential-removed")

const input = Schema.toStandardSchemaV1(CredentialFact.Created.data)

export const createCredential = implementCommand(specification)
  .inputSchema(input)
  .store(createCredentialStore)
  .consistencyKeys({ credential: (command) => command.credentialID })
  .apply(credentialCreated, async (event, state) => {
    state.credentials[event.payload.credentialID] = true
  })
  .apply(credentialRemoved, async (event, state) => {
    delete state.credentials[event.payload.credentialID]
  })
  .handle(async (command, state) => {
    if (state.credentials[command.credentialID]) throw new Error("Credential already exists")
    return [credentialCreated.create(command)]
  })
