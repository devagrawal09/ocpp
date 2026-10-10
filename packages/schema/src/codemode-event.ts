export * as CodeModeEvent from "./codemode-event.js"

import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"
import { optional } from "./schema.js"
import { SessionID } from "./session-id.js"
import { SessionMessage } from "./session-message.js"

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
  /** The invocation message the latest firing started, which the timeline shows as its run. */
  lastMessageID: SessionMessage.ID.pipe(optional),
  /** A short result preview or error from the latest firing. */
  lastSummary: Schema.String.pipe(optional),
  runCount: Schema.Number,
  /** Firings skipped because the previous firing was still running. */
  skipCount: Schema.Number,
  lastSkippedAt: Schema.String.pipe(optional),
}).annotate({ identifier: "CodeModeEvent.Info" })

/**
 * A Session's events changed: a definition, its enabled state, its next firing, or its latest firing and
 * counts. Read the list again for the current state. The latest firing's outcome settles with its
 * invocation message instead.
 */
const Updated = ephemeral({
  type: "codemode-event-updated",
  identifier: "CodeModeEvent.Updated",
  schema: { sessionID: SessionID, name: Schema.String },
})

export const Event = { Updated, Definitions: inventory(Updated) }
