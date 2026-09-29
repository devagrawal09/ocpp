export * as ConfigExperimental from "./experimental.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "../schema.js"

export class Info extends Schema.Class<Info>("ConfigExperimental.Info")({
  subagent_depth: NonNegativeInt.pipe(optional).annotate({
    description: "Maximum subagent nesting depth. Defaults to 1.",
  }),
}) {}
