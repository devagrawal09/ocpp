export * as ConfigOpenAPI from "./openapi.js"

import { Schema } from "effect"
import { optional } from "../schema.js"

export class Entry extends Schema.Class<Entry>("Config.OpenAPI.Entry")({
  spec: Schema.String.annotate({
    description:
      "HTTP(S) URL or file path of an OpenAPI 3.x document. Relative paths resolve from the configuration file's directory.",
  }),
  base_url: Schema.String.pipe(optional).annotate({
    description: "Absolute base URL for every operation, overriding the document's servers.",
  }),
  headers: Schema.Record(Schema.String, Schema.String).pipe(optional).annotate({
    description:
      "HTTP headers sent with every request and never shown to the model. They also satisfy header-based security schemes.",
  }),
  disabled: Schema.Boolean.pipe(optional).annotate({
    description: "Set to true to stop exposing this API's operations.",
  }),
}) {}

export const Info = Schema.Record(Schema.String, Entry)
export type Info = typeof Info.Type
