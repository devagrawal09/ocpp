export * as CodeModeExecution from "./codemode-execution.js"

import { Schema } from "effect"
import { ascending } from "./identifier.js"
import { optional, statics } from "./schema.js"

const IDSchema = Schema.String.check(Schema.isStartsWith("exe_")).pipe(Schema.brand("CodeModeExecution.ID"))

export const ID = IDSchema.pipe(
  statics((schema: typeof IDSchema) => ({
    create: () => schema.make("exe_" + ascending()),
  })),
)
export type ID = typeof ID.Type

const EventText = Schema.String.check(Schema.isMaxLength(4 * 1024))
const EventRecord = Schema.Record(Schema.String, Schema.Json)

export interface ToolEvent extends Schema.Schema.Type<typeof ToolEvent> {}
export const ToolEvent = Schema.Struct({
  type: Schema.Literal("tool"),
  tool: EventText,
  status: Schema.Literals(["running", "completed", "error"]),
  input: EventRecord.pipe(optional),
  output: EventText.pipe(optional),
  metadata: EventRecord.pipe(optional),
  error: EventText.pipe(optional),
}).annotate({ identifier: "CodeModeExecution.ToolEvent" })

export type TraceEvent = typeof TraceEvent.Type
export const TraceEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("trace"),
    kind: Schema.Literal("assignment"),
    target: EventText,
    value: EventText,
  }),
  Schema.Struct({
    type: Schema.Literal("trace"),
    kind: Schema.Literal("branch"),
    expression: EventText,
    result: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("trace"),
    kind: Schema.Literal("operation"),
    operation: EventText,
    input: EventText,
    output: EventText,
  }),
  Schema.Struct({
    type: Schema.Literal("trace"),
    kind: Schema.Literal("log"),
    method: EventText,
    message: EventText,
  }),
  Schema.Struct({ type: Schema.Literal("trace"), kind: Schema.Literal("return"), value: EventText }),
]).annotate({ identifier: "CodeModeExecution.TraceEvent" })

export type Entry = typeof Entry.Type
export const Entry = Schema.Union([ToolEvent, TraceEvent]).annotate({ identifier: "CodeModeExecution.Entry" })

export type Entries = typeof Entries.Type
export const Entries = Schema.suspend(() => Schema.Array(Entry).check(Schema.isMaxLength(200))).annotate({
  identifier: "CodeModeExecution.Entries",
})
