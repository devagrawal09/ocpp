import { Schema } from "effect"
import { FileDiff } from "./file-diff.js"
import { optional } from "./schema.js"
import { SessionMessage } from "./session-message.js"
import { Snapshot } from "./snapshot.js"

export interface Revert extends Schema.Schema.Type<typeof Revert> {}
export const Revert = Schema.Struct({
  messageID: SessionMessage.ID,
  snapshot: Snapshot.ID.pipe(optional),
  files: Schema.Array(FileDiff.Info).pipe(optional),
}).annotate({ identifier: "Session.Revert" })
