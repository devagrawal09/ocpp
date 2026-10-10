export * as ExternalSession from "./external-session.js"

import { Schema } from "effect"
import { Event } from "./event.js"
import { AbsolutePath, optional } from "./schema.js"
import { SessionID } from "./session-id.js"

export const Provider = Schema.Literals(["claude", "codex", "pi"]).annotate({ identifier: "ExternalSession.Provider" })
export type Provider = typeof Provider.Type

export const Status = Schema.Literals(["idle", "running", "completed", "failed", "interrupted"])
export type Status = typeof Status.Type

export const Info = Schema.Struct({
  sessionID: SessionID,
  provider: Provider,
  directory: AbsolutePath,
  vendorSessionID: Schema.String.pipe(optional),
  /** Fingerprint of the vendor's complete model history at the last settled boundary. */
  checkpoint: Schema.String.pipe(optional),
  historyHash: Schema.String.pipe(optional),
  status: Status,
}).annotate({ identifier: "ExternalSession.Info" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

const durable = { aggregate: "sessionID" } as const
export const Bound = Event.durable({
  type: "session-external-bound",
  durable,
  schema: { sessionID: SessionID, provider: Provider, directory: AbsolutePath },
})
export const Linked = Event.durable({
  type: "session-external-linked",
  durable,
  schema: { sessionID: SessionID, vendorSessionID: Schema.String },
})
export const Checkpointed = Event.durable({
  type: "session-external-checkpointed",
  durable,
  schema: { sessionID: SessionID, checkpoint: Schema.String, historyHash: Schema.String },
})
/** Internal persistence facts; ordinary Session events carry the user-visible stream. */
export const Definitions = Event.inventory(Bound, Linked, Checkpointed)
