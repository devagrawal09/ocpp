export * as CredentialFact from "./credential-fact.js"

import { Schema } from "effect"
import { Credential } from "./credential.js"
import { Event } from "./event.js"
import { IntegrationID } from "./integration-id.js"
import { optional } from "./schema.js"

const byCredential = { aggregate: "credentialID", version: 1 } as const
const credential = { credentialID: Credential.ID, integrationID: IntegrationID }

// A credential's secret enters the log sealed with a key of its own, which is kept apart from the log
// and deleted with the credential: an append-only log cannot forget a secret, but without its key every
// copy of it is unreadable.

/** A secret encrypted with AES-GCM under its credential's key: the IV and ciphertext, base64. */
export const Sealed = Schema.Struct({ iv: Schema.String, data: Schema.String })
export type Sealed = typeof Sealed.Type

/** A credential was stored for its integration and became the one the integration uses. */
export const Created = Event.durable({
  type: "credential-created",
  durable: byCredential,
  schema: { ...credential, label: Schema.String, secret: Sealed },
})
/** The integration switched to this credential. */
export const Activated = Event.durable({
  type: "credential-activated",
  durable: byCredential,
  schema: credential,
})
export const Relabeled = Event.durable({
  type: "credential-relabeled",
  durable: byCredential,
  schema: { ...credential, label: Schema.String },
})
/** The credential's secret changed: a new key, or refreshed tokens. */
export const Rotated = Event.durable({
  type: "credential-rotated",
  durable: byCredential,
  schema: { ...credential, secret: Sealed },
})
/** The credential was removed with its secret; when it was in use, the newest remaining one replaces it. */
export const Removed = Event.durable({
  type: "credential-removed",
  durable: byCredential,
  schema: { ...credential, replacement: optional(Credential.ID) },
})

/** Internal persistence facts of credentials; clients see `credential-updated` and `credential-switched`. */
export const Definitions = Event.inventory(Created, Activated, Relabeled, Rotated, Removed)
