export * as SessionFact from "./session-fact.js"

import { Schema } from "effect"
import { CodeModeEvent } from "./codemode-event.js"
import { Event } from "./event.js"
import { InstructionEntry } from "./instruction-entry.js"
import { NonNegativeInt, optional } from "./schema.js"
import { SessionID } from "./session-id.js"
import { SessionMessage } from "./session-message.js"

const bySession = { aggregate: "sessionID" } as const

/**
 * A Session created from another server's export, recorded with its creation: its settled messages and
 * what the Session had used and when, as the export gave them.
 */
export const Imported = Event.durable({
  type: "session-imported",
  durable: bySession,
  schema: {
    sessionID: SessionID,
    messages: Schema.Array(
      Schema.Struct({
        id: SessionMessage.ID,
        type: Schema.String,
        seq: NonNegativeInt,
        created: NonNegativeInt,
        data: Schema.Json,
      }),
    ),
    cost: Schema.Number,
    tokens: Schema.Struct({
      input: NonNegativeInt,
      output: NonNegativeInt,
      reasoning: NonNegativeInt,
      cacheRead: NonNegativeInt,
      cacheWrite: NonNegativeInt,
    }),
    time: Schema.Struct({
      created: NonNegativeInt,
      updated: NonNegativeInt,
      idle: optional(NonNegativeInt),
      viewed: optional(NonNegativeInt),
      archived: optional(NonNegativeInt),
    }),
    outcome: optional(Schema.Literals(["succeeded", "failed", "interrupted"])),
  },
})

/**
 * A page of the history a fork copies from its parent through the boundary: the parent's settled messages, in order,
 * as its projection held them (a Code Mode result promising a run the fork does not own already says so). A fork
 * records its whole history in its one commit, before its `session-forked`, in pages of bounded size, so no one fact
 * grows with the parent's history. Each copied message keeps its sequence in the parent, which the fork reserves (its
 * own events follow), and is named by its page's ID and that sequence.
 */
export const HistoryCopied = Event.durable({
  type: "session-history-copied",
  durable: bySession,
  schema: {
    sessionID: SessionID,
    messages: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        seq: NonNegativeInt,
        created: NonNegativeInt,
        updated: NonNegativeInt,
        data: Schema.Json,
      }),
    ),
  },
})

/** Instruction values the Session's instructions refer to by hash, stored with the update that uses them. */
export const InstructionBlobsStored = Event.durable({
  type: "session-instruction-blobs-stored",
  durable: bySession,
  schema: { sessionID: SessionID, blobs: Schema.Record(Schema.String, Schema.Json) },
})

/** An API client attached a value to the Session's instructions, or changed it. */
export const InstructionEntrySet = Event.durable({
  type: "session-instruction-entry-set",
  durable: bySession,
  schema: { sessionID: SessionID, key: InstructionEntry.Key, value: Schema.Json },
})
export const InstructionEntryRemoved = Event.durable({
  type: "session-instruction-entry-removed",
  durable: bySession,
  schema: { sessionID: SessionID, key: InstructionEntry.Key },
})

// An execution's facts are its own aggregate: journaling its calls does not advance the Session's
// sequence. Each carries its Session, which its rows belong to.
const byExecution = { aggregate: "executionID" } as const
const execution = { sessionID: SessionID, executionID: Schema.String }

/** A Code Mode program received its execution: the notebook names it sees and the names it reserves. */
export const ExecutionAdmitted = Event.durable({
  type: "session-codemode-execution-admitted",
  durable: byExecution,
  schema: {
    ...execution,
    assistantMessageID: SessionMessage.ID,
    toolCallID: Schema.String,
    program: Schema.Json,
    input: optional(Schema.Json),
    tools: optional(Schema.Json),
    snapshot: Schema.Array(Schema.String),
    reserved: Schema.Array(Schema.String),
  },
})
export const ExecutionStarted = Event.durable({
  type: "session-codemode-execution-started",
  durable: byExecution,
  schema: execution,
})
/** A running execution resumed after its host restarted. */
export const ExecutionResumed = Event.durable({
  type: "session-codemode-execution-resumed",
  durable: byExecution,
  schema: execution,
})
/**
 * An execution ended. A `finished` program saved the values of its declarations into its Session's notebook;
 * one that finished but could not save them (its names were not its own, or they did not fit) is `failed`
 * with why, as is one whose message a revert cut. A `failed` or `indeterminate` execution saved nothing, and
 * its calls still scheduled settle with it.
 */
export const ExecutionSettled = Event.durable({
  type: "session-codemode-execution-settled",
  durable: byExecution,
  schema: {
    ...execution,
    outcome: Schema.Literals(["finished", "failed", "indeterminate"]),
    values: optional(Schema.Record(Schema.String, Schema.Json)),
    error: optional(Schema.String),
  },
})
/** An execution admitted but never started was withdrawn. */
export const ExecutionDiscarded = Event.durable({
  type: "session-codemode-execution-discarded",
  durable: byExecution,
  schema: execution,
})

const call = { ...execution, index: NonNegativeInt }

export const CallScheduled = Event.durable({
  type: "session-codemode-call-scheduled",
  durable: byExecution,
  schema: {
    ...call,
    tool: Schema.String,
    input: Schema.Json,
    omitted: Schema.Boolean,
    impure: optional(Schema.Array(Schema.Number)),
  },
})
export const CallProgressed = Event.durable({
  type: "session-codemode-call-progressed",
  durable: byExecution,
  schema: { ...call, progress: Schema.Record(Schema.String, Schema.Json) },
})
export const CallSettled = Event.durable({
  type: "session-codemode-call-settled",
  durable: byExecution,
  schema: {
    ...call,
    outcome: Schema.Literals(["completed", "failed", "indeterminate"]),
    output: optional(Schema.Json),
    error: optional(Schema.String),
    omitted: Schema.Boolean,
  },
})

/**
 * A fork's notebook, copied from its parent through the boundary, before its `session-forked`: the values its history
 * saved, each with the execution that saved it and the sequence of that execution's message, by which a revert of the
 * fork cuts it; and the commands and events whose handler those values hold, with when the parent defined and last
 * changed them. Events are copied disabled, with no firing history; reservations stay with the parent.
 */
export const NotebookCopied = Event.durable({
  type: "session-codemode-notebook-copied",
  durable: bySession,
  schema: {
    sessionID: SessionID,
    values: Schema.Record(
      Schema.String,
      Schema.Struct({ value: Schema.Json, executionID: Schema.String, seq: NonNegativeInt }),
    ),
    commands: Schema.Record(
      Schema.String,
      Schema.Struct({
        description: Schema.String,
        handler: Schema.String,
        created: NonNegativeInt,
        updated: NonNegativeInt,
      }),
    ),
    events: Schema.Record(
      Schema.String,
      Schema.Struct({
        description: Schema.String,
        schedule: CodeModeEvent.Schedule,
        handler: Schema.String,
        input: optional(Schema.Json),
        created: NonNegativeInt,
        updated: NonNegativeInt,
      }),
    ),
  },
})
/**
 * A committed revert's cut of the notebook: the executions whose message it removed, so their saved values go
 * with it. One still running settled failed in the same commit.
 */
export const NotebookReverted = Event.durable({
  type: "session-codemode-notebook-reverted",
  durable: bySession,
  schema: { sessionID: SessionID, executions: Schema.Array(Schema.String) },
})

const named = { sessionID: SessionID, name: Schema.String }

/** A slash command of the Session, calling a notebook function; defining an existing one replaces it. */
export const CommandDefined = Event.durable({
  type: "session-codemode-command-defined",
  durable: bySession,
  schema: { ...named, description: Schema.String, handler: Schema.String },
})
export const CommandRemoved = Event.durable({
  type: "session-codemode-command-removed",
  durable: bySession,
  schema: named,
})
/** A scheduled event of the Session; defining an existing one replaces it and starts it over. */
export const EventDefined = Event.durable({
  type: "session-codemode-event-defined",
  durable: bySession,
  schema: {
    ...named,
    description: Schema.String,
    schedule: CodeModeEvent.Schedule,
    handler: Schema.String,
    input: optional(Schema.Json),
    time: NonNegativeInt,
    next: optional(NonNegativeInt),
  },
})
export const EventToggled = Event.durable({
  type: "session-codemode-event-toggled",
  durable: bySession,
  schema: { ...named, enabled: Schema.Boolean },
})
export const EventRemoved = Event.durable({
  type: "session-codemode-event-removed",
  durable: bySession,
  schema: named,
})
/** When the scheduler will fire the event next, or that it will not. */
export const EventPlanned = Event.durable({
  type: "session-codemode-event-planned",
  durable: bySession,
  schema: { ...named, next: optional(NonNegativeInt) },
})
/** A firing: the execution it started and its invocation message, or why it could not start. */
export const EventFired = Event.durable({
  type: "session-codemode-event-fired",
  durable: bySession,
  schema: {
    ...named,
    at: NonNegativeInt,
    executionID: optional(Schema.String),
    messageID: optional(SessionMessage.ID),
    error: optional(Schema.String),
  },
})
export const EventSkipped = Event.durable({
  type: "session-codemode-event-skipped",
  durable: bySession,
  schema: { ...named, at: NonNegativeInt },
})

// A background job's marker is its own aggregate, keyed by the notification its result arrives in: it
// is recorded from the job registry, which Session listeners call while holding their Session. Each of
// its facts names the Session its notification arrives in, which owns it: the marker goes with it.
const byNotification = { aggregate: "notificationID" } as const

/** How restart recovery resumes a background job: a shell, a subagent's Session or a Code Mode run. */
export const BackgroundRecovery = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("shell"),
    sessionID: SessionID,
    shellID: Schema.String,
    command: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("subagent"),
    parentSessionID: SessionID,
    childSessionID: SessionID,
    agent: Schema.String,
    description: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("codemode"),
    parentSessionID: SessionID,
    assistantMessageID: SessionMessage.ID,
    toolCallID: Schema.String,
  }),
])
export type BackgroundRecovery = typeof BackgroundRecovery.Type

/** A recoverable job went to the background: until its notification is delivered, a restart resumes it. */
export const BackgroundStarted = Event.durable({
  type: "session-background-started",
  durable: byNotification,
  schema: {
    notificationID: SessionMessage.ID,
    sessionID: SessionID,
    jobID: Schema.String,
    recovery: BackgroundRecovery,
  },
})
/**
 * The one terminal of the job: how it ended, with its output or error. A job that ended before it went to
 * the background records its start and its settlement together.
 */
export const BackgroundSettled = Event.durable({
  type: "session-background-settled",
  durable: byNotification,
  schema: {
    notificationID: SessionMessage.ID,
    sessionID: SessionID,
    outcome: Schema.Literals(["completed", "error", "cancelled"]),
    output: optional(Schema.String),
    error: optional(Schema.String),
  },
})
/**
 * The job's outcome reached its Session (for a Code Mode run, its `session-codemode-settled` does this); only its
 * notification is left to deliver.
 */
export const BackgroundTerminal = Event.durable({
  type: "session-background-terminal",
  durable: byNotification,
  schema: { notificationID: SessionMessage.ID, sessionID: SessionID },
})
/**
 * The job's notification was delivered, or the job discarded (its Session's deletion discards it): nothing is
 * left to recover, and the marker goes.
 */
export const BackgroundCompleted = Event.durable({
  type: "session-background-completed",
  durable: byNotification,
  schema: { notificationID: SessionMessage.ID, sessionID: SessionID },
})

/**
 * Internal persistence facts of a Session's API instruction entries, Code Mode state and background
 * jobs. OC++'s instruction entry, Code Mode and background job rows are their projections; clients see
 * the ordinary Session and Code Mode notifications.
 */
export const Definitions = Event.inventory(
  Imported,
  HistoryCopied,
  InstructionBlobsStored,
  InstructionEntrySet,
  InstructionEntryRemoved,
  ExecutionAdmitted,
  ExecutionStarted,
  ExecutionResumed,
  ExecutionSettled,
  ExecutionDiscarded,
  CallScheduled,
  CallProgressed,
  CallSettled,
  NotebookCopied,
  NotebookReverted,
  CommandDefined,
  CommandRemoved,
  EventDefined,
  EventToggled,
  EventRemoved,
  EventPlanned,
  EventFired,
  EventSkipped,
  BackgroundStarted,
  BackgroundSettled,
  BackgroundTerminal,
  BackgroundCompleted,
)
