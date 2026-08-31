export * as ConfigSubagent from "./subagent.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

const Model = Schema.String.check(Schema.isPattern(/^[^/#]+\/[^#]+$/))

export class Info extends Schema.Class<Info>("Config.Subagent")({
  models: Model.pipe(Schema.Array, optional).annotate({
    description: "Models that subagents may select without asking for approval. Variants are allowed automatically.",
  }),
}) {}
