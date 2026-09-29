export * as Command from "./command.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { optional } from "./schema.js"

const Updated = ephemeral({ type: "command.updated", schema: {} })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.String.pipe(optional),
}).annotate({ identifier: "Command.Info" })

/** Slash commands the web app handles itself. A Session command may not take one of these names. */
export const Builtin = [
  "new",
  "undo",
  "redo",
  "compact",
  "fork",
  "export",
  "open",
  "terminal",
  "mcp",
  "model",
  "agent",
] as const
export type Builtin = (typeof Builtin)[number]

export const Event = {
  Updated,
  Definitions: inventory(Updated),
}
