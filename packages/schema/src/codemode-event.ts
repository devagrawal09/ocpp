export * as CodeModeEvent from "./codemode-event.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

/** When an event fires: a repeating interval such as "30s", "5m", or "1h", a cron expression, or one ISO time. */
export const Schedule = Schema.Union([
  Schema.Struct({ every: Schema.String }),
  Schema.Struct({ cron: Schema.String }),
  Schema.Struct({ at: Schema.String }),
]).annotate({ identifier: "CodeModeEvent.Schedule" })
export type Schedule = typeof Schedule.Type

export const Status = Schema.Literals(["running", "completed", "error", "cancelled"]).annotate({
  identifier: "CodeModeEvent.Status",
})
export type Status = typeof Status.Type

/** A schedule whose firings run a saved notebook function, with its latest firing. Times are ISO 8601. */
export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  schedule: Schedule,
  /** Name of the top-level notebook function that receives `{ event, firedAt, input }`. */
  handler: Schema.String,
  input: Schema.Json.pipe(optional),
  enabled: Schema.Boolean,
  nextFireAt: Schema.String.pipe(optional),
  lastFiredAt: Schema.String.pipe(optional),
  lastStatus: Status.pipe(optional),
  /** A short result preview or error from the latest firing. */
  lastSummary: Schema.String.pipe(optional),
  runCount: Schema.Number,
  /** Firings skipped because the previous firing was still running. */
  skipCount: Schema.Number,
  lastSkippedAt: Schema.String.pipe(optional),
}).annotate({ identifier: "CodeModeEvent.Info" })
