export * as CodeModeCommand from "./codemode-command.js"

import { Schema } from "effect"

/** A slash command whose invocation runs a saved notebook function instead of prompting the model. */
export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  /** Name of the top-level notebook function that receives `{ text, command }`. */
  handler: Schema.String,
}).annotate({ identifier: "CodeModeCommand.Info" })
