// Public entry for a host process (OC++ core) that embeds the runtime.
// Hosts import only from here; everything else is the runtime's own layout.

// A Command's rejection: the runtime refused it with a stable code (`error.rejection.code`), one of
// `RejectionCode`, which the host matches on.
export { SpecterCommandRejectedError } from "@specter-ts/core"
export type { RejectionCode } from "./rejections.ts"
// The Event Log contract a host implements when it keeps the log itself.
export {
  type EventDraft,
  type EventKey,
  EventLog,
  type EventLogAppendCondition,
  type EventLogAppendOptions,
  type EventLogCapabilities,
  type EventLogCommit,
  type EventLogDraft,
  EventLogFailure,
  type EventLogKeyPage,
  type EventLogService,
  type PersistedEvent,
  SpecterVersionConflictError,
} from "@specter-ts/core"
// The outbox contract a host implements when it keeps the runtime's jobs.
export {
  type ReactionOutboxClaim,
  type ReactionOutboxJob,
  ReactionOutboxLeaseLostError,
  type ReactionOutboxStatus,
  type ReactionOutboxStore,
} from "@specter-ts/reaction-outbox"

export type { DriveExecutionOutboxStore, ProvideSliceStore, RunStepOutboxStore } from "./app.ts"
export { makeSnapshotSliceStores, type SliceSnapshot } from "./snapshots.ts"
export { makeRuntime, type Runtime } from "./runtime.ts"
export { sessionEvent, sessionEventDefinitions } from "./events.ts"
export {
  type AttemptOutcome,
  type AttemptRecorder,
  type CompactFirst,
  type CompactionOutcome,
  type CompactionRecorder,
  type CompactionUsage,
  type DriveInbox,
  type DriveOutcome,
  type PrepareOutcome,
  type RecordFailure,
  StepHost,
  type StepPlan,
} from "./plugins/step-host.ts"
