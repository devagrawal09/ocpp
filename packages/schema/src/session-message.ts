export * as SessionMessage from "./session-message.js"

import { Schema } from "effect"
import { optional } from "./schema.js"
import { Content } from "./tool.js"
import { Location } from "./location.js"
import { Model } from "./model.js"
import { Project } from "./project.js"
import { Prompt } from "./prompt.js"
import { DateTimeUtcFromMillis, PositiveInt, RelativePath, brand, statics } from "./schema.js"
import { ascending } from "./identifier.js"
import { Event } from "./event.js"
import { Shell as ShellSchema } from "./shell.js"
import { FinishReason } from "./llm.js"
import { SessionError } from "./session-error.js"
import { Agent } from "./agent.js"
import { Skill as SkillSchema } from "./skill.js"
import { Money } from "./money.js"
import { Snapshot } from "./snapshot.js"
import { TokenUsage } from "./token-usage.js"
import { CodeModeExecution } from "./codemode-execution.js"

export const ID = Schema.String.check(Schema.isStartingWith("msg_")).pipe(
  brand("Session.Message.ID"),
  statics((schema) => ({
    create: () => schema.make("msg_" + ascending()),
    fromEvent: (eventID: Event.ID) => schema.make(eventID.replace(/^evt_/, "msg_")),
  })),
)
export type ID = typeof ID.Type

const Base = {
  id: ID,
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
  time: Schema.Struct({ created: DateTimeUtcFromMillis }),
}

export const ProviderState = Schema.Record(Schema.String, Schema.Unknown).annotate({
  identifier: "Session.Message.ProviderState",
})
export type ProviderState = typeof ProviderState.Type

export interface AgentSelected extends Schema.Schema.Type<typeof AgentSelected> {}
export const AgentSelected = Schema.Struct({
  ...Base,
  type: Schema.tag("agent-switched"),
  agent: Agent.ID,
  previous: Agent.ID.pipe(optional),
}).annotate({ identifier: "Session.Message.AgentSelected" })

export interface ModelSelected extends Schema.Schema.Type<typeof ModelSelected> {}
export const ModelSelected = Schema.Struct({
  ...Base,
  type: Schema.tag("model-switched"),
  model: Model.Ref,
  previous: Model.Ref.pipe(optional),
}).annotate({ identifier: "Session.Message.ModelSelected" })

export interface LocationSwitched extends Schema.Schema.Type<typeof LocationSwitched> {}
export const LocationSwitched = Schema.Struct({
  ...Base,
  type: Schema.tag("location-switched"),
  location: Location.Ref,
  projectID: Project.ID.pipe(optional),
  subpath: RelativePath.pipe(optional),
  previous: Schema.Struct({
    location: Location.Ref,
    projectID: Project.ID.pipe(optional),
    subpath: RelativePath.pipe(optional),
  }).pipe(optional),
}).annotate({ identifier: "Session.Message.LocationSwitched" })

export interface User extends Schema.Schema.Type<typeof User> {}
export const User = Schema.Struct({
  ...Base,
  text: Prompt.fields.text,
  files: Prompt.fields.files,
  agents: Prompt.fields.agents,
  skills: Prompt.fields.skills,
  type: Schema.tag("user"),
}).annotate({ identifier: "Session.Message.User" })

export interface Synthetic extends Schema.Schema.Type<typeof Synthetic> {}
export const Synthetic = Schema.Struct({
  ...Base,
  text: Schema.String,
  description: Schema.String.pipe(optional),
  files: Prompt.fields.files,
  type: Schema.tag("synthetic"),
}).annotate({ identifier: "Session.Message.Synthetic" })

export interface System extends Schema.Schema.Type<typeof System> {}
export const System = Schema.Struct({
  ...Base,
  type: Schema.tag("system"),
  /** The model-facing update text, frozen at emit time. */
  text: Schema.String,
  /** A short human-readable summary for transcript display. */
  description: Schema.String.pipe(optional),
}).annotate({ identifier: "Session.Message.System" })

export interface Skill extends Schema.Schema.Type<typeof Skill> {}
export const Skill = Schema.Struct({
  ...Base,
  type: Schema.tag("skill"),
  skill: SkillSchema.ID,
  name: SkillSchema.Name,
  text: Schema.String,
}).annotate({ identifier: "Session.Message.Skill" })

export interface Shell extends Schema.Schema.Type<typeof Shell> {}
export const Shell = Schema.Struct({
  ...Base,
  type: Schema.tag("shell"),
  shellID: ShellSchema.ID,
  command: Schema.String,
  status: ShellSchema.Status,
  exit: Schema.Number.pipe(optional),
  output: ShellSchema.Output.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Session.Message.Shell" })

/**
 * Bounds on one displayed result. A result past them is rejected, never truncated. The Session checks
 * `bytes` and table consistency when it publishes, since they span several fields. `bytes` stays well
 * below the Code Mode journal's 256 KiB capture limit, so a call that displays a valid result can always
 * be replayed after a restart.
 */
export const DisplayLimits = {
  title: 200,
  blocks: 50,
  text: 100_000,
  columns: 20,
  rows: 1_000,
  cell: 10_000,
  bytes: 128 * 1024,
} as const

const DisplayText = Schema.String.check(Schema.isMaxLength(DisplayLimits.text))
const DisplayLabel = Schema.String.check(Schema.isMaxLength(DisplayLimits.title))

/** A table cell that names a file, opened like any other file reference. */
export interface DisplayFile extends Schema.Schema.Type<typeof DisplayFile> {}
export const DisplayFile = Schema.Struct({
  type: Schema.tag("file"),
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
}).annotate({ identifier: "Session.Message.Display.File" })

export const DisplayCell = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.Finite,
  Schema.String.check(Schema.isMaxLength(DisplayLimits.cell)),
  DisplayFile,
]).annotate({ identifier: "Session.Message.Display.Cell" })
export type DisplayCell = typeof DisplayCell.Type

export interface DisplayMarkdown extends Schema.Schema.Type<typeof DisplayMarkdown> {}
export const DisplayMarkdown = Schema.Struct({
  type: Schema.tag("markdown"),
  text: DisplayText,
}).annotate({ identifier: "Session.Message.Display.Markdown" })

export interface DisplayCode extends Schema.Schema.Type<typeof DisplayCode> {}
export const DisplayCode = Schema.Struct({
  type: Schema.tag("code"),
  text: DisplayText,
  language: Schema.String.check(Schema.isMaxLength(64)).pipe(optional),
}).annotate({ identifier: "Session.Message.Display.Code" })

export interface DisplayColumn extends Schema.Schema.Type<typeof DisplayColumn> {}
export const DisplayColumn = Schema.Struct({
  key: DisplayLabel.check(Schema.isMinLength(1)),
  label: DisplayLabel,
}).annotate({ identifier: "Session.Message.Display.Column" })

export interface DisplayTable extends Schema.Schema.Type<typeof DisplayTable> {}
export const DisplayTable = Schema.Struct({
  type: Schema.tag("table"),
  columns: Schema.Array(DisplayColumn).check(Schema.isMinLength(1), Schema.isMaxLength(DisplayLimits.columns)),
  rows: Schema.Array(Schema.Record(Schema.String, DisplayCell)).check(Schema.isMaxLength(DisplayLimits.rows)),
}).annotate({ identifier: "Session.Message.Display.Table" })

export const DisplayBlock = Schema.Union([DisplayMarkdown, DisplayTable, DisplayCode])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Session.Message.Display.Block" })
export type DisplayBlock = DisplayMarkdown | DisplayTable | DisplayCode

/** What code publishes as one result: an optional title and its ordered blocks. */
export const DisplayFields = {
  title: DisplayLabel.pipe(optional),
  blocks: Schema.Array(DisplayBlock).check(Schema.isMinLength(1), Schema.isMaxLength(DisplayLimits.blocks)),
}

export interface DisplayInput extends Schema.Schema.Type<typeof DisplayInput> {}
export const DisplayInput = Schema.Struct(DisplayFields).annotate({ identifier: "Session.Message.DisplayInput" })

/**
 * A user-facing result that code published with `display_result`. It is presentation history only and
 * never reaches the model.
 */
export interface Display extends Schema.Schema.Type<typeof Display> {}
export const Display = Schema.Struct({
  ...Base,
  type: Schema.tag("display"),
  ...DisplayFields,
}).annotate({ identifier: "Session.Message.Display" })

export const InvocationTrigger = Schema.Union([
  Schema.Struct({ type: Schema.tag("command"), name: Schema.String, text: Schema.String }),
  Schema.Struct({ type: Schema.tag("event"), name: Schema.String }),
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Session.Message.InvocationTrigger" })
export type InvocationTrigger = typeof InvocationTrigger.Type

/** The program an invocation runs. Its input is written into it, so the stored plan alone reproduces the run. */
export const invocationCode = (handler: string, input: Schema.Json) =>
  "return " + handler + "(" + JSON.stringify(input) + ")"

/**
 * A Code Mode execution that a command or an event started outside the model. It is display
 * history: its outcome reaches the model through the execution's later completion notification.
 */
export interface Invocation extends Schema.Schema.Type<typeof Invocation> {}
export const Invocation = Schema.Struct({
  ...Base,
  type: Schema.tag("invocation"),
  trigger: InvocationTrigger,
  code: Schema.String,
  executionID: CodeModeExecution.ID,
  status: Schema.Literals(["running", "completed", "error", "cancelled"]),
  events: CodeModeExecution.Entries.pipe(optional),
  error: Schema.String.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Session.Message.Invocation" })

export interface ToolStateStreaming extends Schema.Schema.Type<typeof ToolStateStreaming> {}
export const ToolStateStreaming = Schema.Struct({
  status: Schema.tag("streaming"),
  input: Schema.String,
}).annotate({ identifier: "Session.Message.ToolState.Streaming" })

export interface ToolStateRunning extends Schema.Schema.Type<typeof ToolStateRunning> {}
export const ToolStateRunning = Schema.Struct({
  status: Schema.tag("running"),
  input: Schema.Record(Schema.String, Schema.Unknown),
  metadata: Schema.Record(Schema.String, Schema.Json),
}).annotate({ identifier: "Session.Message.ToolState.Running" })

export interface ToolStateCompleted extends Schema.Schema.Type<typeof ToolStateCompleted> {}
export const ToolStateCompleted = Schema.Struct({
  status: Schema.tag("completed"),
  input: Schema.Record(Schema.String, Schema.Unknown),
  content: Schema.NonEmptyArray(Content),
  metadata: Schema.Record(Schema.String, Schema.Json).pipe(optional),
}).annotate({ identifier: "Session.Message.ToolState.Completed" })

export interface ToolStateError extends Schema.Schema.Type<typeof ToolStateError> {}
export const ToolStateError = Schema.Struct({
  status: Schema.tag("error"),
  input: Schema.Record(Schema.String, Schema.Unknown),
  error: SessionError.Error,
  content: Schema.NonEmptyArray(Content).pipe(optional),
  metadata: Schema.Record(Schema.String, Schema.Json).pipe(optional),
}).annotate({ identifier: "Session.Message.ToolState.Error" })

export const ToolState = Schema.Union([ToolStateStreaming, ToolStateRunning, ToolStateCompleted, ToolStateError]).pipe(
  Schema.toTaggedUnion("status"),
)
export type ToolState = ToolStateStreaming | ToolStateRunning | ToolStateCompleted | ToolStateError

export interface AssistantTool extends Schema.Schema.Type<typeof AssistantTool> {}
export const AssistantTool = Schema.Struct({
  type: Schema.tag("tool"),
  id: Schema.String,
  name: Schema.String,
  executed: Schema.Boolean.pipe(optional),
  providerState: ProviderState.pipe(optional),
  providerResultState: ProviderState.pipe(optional),
  state: ToolState,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    ran: DateTimeUtcFromMillis.pipe(optional),
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Session.Message.Assistant.Tool" })

export interface AssistantText extends Schema.Schema.Type<typeof AssistantText> {}
export const AssistantText = Schema.Struct({
  type: Schema.tag("text"),
  text: Schema.String,
  state: ProviderState.pipe(optional),
}).annotate({ identifier: "Session.Message.Assistant.Text" })

export interface AssistantReasoning extends Schema.Schema.Type<typeof AssistantReasoning> {}
export const AssistantReasoning = Schema.Struct({
  type: Schema.tag("reasoning"),
  text: Schema.String,
  state: ProviderState.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }).pipe(optional),
}).annotate({ identifier: "Session.Message.Assistant.Reasoning" })

export const AssistantContent = Schema.Union([AssistantText, AssistantReasoning, AssistantTool]).pipe(
  Schema.toTaggedUnion("type"),
)
export type AssistantContent = AssistantText | AssistantReasoning | AssistantTool

export const AssistantContentEncoded = Schema.toEncoded(AssistantContent).annotate({
  identifier: "Session.Message.AssistantContent.Encoded",
})
export type AssistantContentEncoded = typeof AssistantContentEncoded.Type

export interface AssistantRetry extends Schema.Schema.Type<typeof AssistantRetry> {}
export const AssistantRetry = Schema.Struct({
  attempt: PositiveInt,
  at: DateTimeUtcFromMillis,
  error: SessionError.Error,
}).annotate({ identifier: "Session.Message.Assistant.Retry" })

export interface Assistant extends Schema.Schema.Type<typeof Assistant> {}
export const Assistant = Schema.Struct({
  ...Base,
  type: Schema.tag("assistant"),
  agent: Agent.ID,
  model: Model.Ref,
  content: AssistantContent.pipe(Schema.Array),
  snapshot: Schema.Struct({
    start: Snapshot.ID.pipe(optional),
    end: Snapshot.ID.pipe(optional),
    files: Schema.Array(RelativePath).pipe(optional),
  }).pipe(optional),
  finish: FinishReason.pipe(optional),
  rawFinish: Schema.String.pipe(optional),
  providerState: ProviderState.pipe(optional),
  cost: Money.USD.pipe(optional),
  tokens: TokenUsage.Info.pipe(optional),
  error: SessionError.Error.pipe(optional),
  retry: AssistantRetry.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    /** When the provider response body ended, before tool settlement. */
    streamed: DateTimeUtcFromMillis.pipe(optional),
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Session.Message.Assistant" })

const CompactionBase = { type: Schema.tag("compaction"), ...Base }

export interface CompactionRunning extends Schema.Schema.Type<typeof CompactionRunning> {}
export const CompactionRunning = Schema.Struct({
  ...CompactionBase,
  status: Schema.tag("running"),
  reason: Schema.Literals(["auto", "manual"]),
  summary: Schema.String,
  recent: Schema.String,
}).annotate({ identifier: "Session.Message.Compaction.Running" })

export interface CompactionCompleted extends Schema.Schema.Type<typeof CompactionCompleted> {}
export const CompactionCompleted = Schema.Struct({
  ...CompactionBase,
  status: Schema.tag("completed"),
  reason: Schema.Literals(["auto", "manual"]),
  summary: Schema.String,
  recent: Schema.String,
}).annotate({ identifier: "Session.Message.Compaction.Completed" })

export interface CompactionFailed extends Schema.Schema.Type<typeof CompactionFailed> {}
export const CompactionFailed = Schema.Struct({
  ...CompactionBase,
  status: Schema.tag("failed"),
  reason: Schema.Literals(["auto", "manual"]),
  error: SessionError.Error,
}).annotate({ identifier: "Session.Message.Compaction.Failed" })

export const Compaction = Schema.Union([CompactionRunning, CompactionCompleted, CompactionFailed]).pipe(
  Schema.toTaggedUnion("status"),
  Schema.annotate({ identifier: "Session.Message.Compaction" }),
)
export type Compaction = CompactionRunning | CompactionCompleted | CompactionFailed

export const Info = Schema.Union([
  AgentSelected,
  ModelSelected,
  LocationSwitched,
  User,
  Synthetic,
  System,
  Skill,
  Shell,
  Display,
  Invocation,
  Assistant,
  Compaction,
]).annotate({ identifier: "Session.Message.Info" })
export type Info =
  | AgentSelected
  | ModelSelected
  | LocationSwitched
  | User
  | Synthetic
  | System
  | Skill
  | Shell
  | Display
  | Invocation
  | Assistant
  | Compaction
export type Type = Info["type"]
