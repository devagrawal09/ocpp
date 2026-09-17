export * as ConfigExternalAgent from "./external-agent.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

const Provider = Schema.Struct({
  enabled: Schema.Boolean.pipe(optional),
  model: Schema.String.pipe(optional),
  effort: Schema.String.pipe(optional),
})
export class Info extends Schema.Class<Info>("Config.ExternalAgent")({
  claude: Provider.pipe(optional),
  codex: Provider.pipe(optional),
  pi: Provider.pipe(optional),
}) {}
