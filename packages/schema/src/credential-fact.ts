export * as CredentialFact from "./credential-fact.js"

import { Schema } from "effect"
import { Credential } from "./credential.js"
import { Event } from "./event.js"
import { IntegrationID } from "./integration-id.js"
import { optional } from "./schema.js"

// Keyed by credential: a credential stored before integrations has none.
const byCredential = { aggregate: "credentialID", version: 1 } as const
const credential = { credentialID: Credential.ID, integrationID: IntegrationID }

// A credential's secret never enters the log: an append-only log cannot forget it. The facts say what
// happened to the credential, and its secret is kept apart, written in the transaction that records
// the fact and deleted with the credential.

/** A credential was stored for its integration and became the one the integration uses. */
export const Created = Event.durable({
  type: "credential.created",
  durable: byCredential,
  schema: { ...credential, label: Schema.String },
})
/** The integration switched to this credential. */
export const Activated = Event.durable({
  type: "credential.activated",
  durable: byCredential,
  schema: credential,
})
export const Relabeled = Event.durable({
  type: "credential.relabeled",
  durable: byCredential,
  schema: { ...credential, label: Schema.String },
})
/** The credential's secret changed: a new key, or refreshed tokens. */
export const Rotated = Event.durable({
  type: "credential.rotated",
  durable: byCredential,
  schema: credential,
})
/** The credential was removed with its secret; when it was in use, the newest remaining one replaces it. */
export const Removed = Event.durable({
  type: "credential.removed",
  durable: byCredential,
  schema: {
    credentialID: Credential.ID,
    integrationID: optional(IntegrationID),
    replacement: optional(Credential.ID),
  },
})

/** Internal persistence facts of credentials; clients see `credential.updated` and `credential.switched`. */
export const Definitions = Event.inventory(Created, Activated, Relabeled, Rotated, Removed)
