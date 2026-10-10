// Public entry for a host process (OC++ core) that embeds the runtime.
// Hosts import only from here; everything else is the runtime's own layout.

// A Command's rejection: the runtime refused it with an exact reason.
export { SpecterCommandRejectedError } from "@specter-ts/core"
// The Event Log contract a host implements when it keeps the log itself.
export {
  type EventDraft,
  EventLog,
  type EventLogCommit,
  EventLogFailure,
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
export { makeSessionEventStore } from "./event-store.ts"
export { makeSnapshotSliceStores, type SliceSnapshot } from "./snapshots.ts"
export { type EmbeddedSessionRuntime, makeEmbeddedSessionRuntime } from "./embedded.ts"
export { sessionEvent, sessionEventDefinitions, toOcppEventType, toSpecterEventType } from "./events.ts"
export {
  type AttemptOutcome,
  type AttemptRecorder,
  type CompactFirst,
  type CompactionOutcome,
  type DriveInbox,
  type DriveOutcome,
  type PrepareOutcome,
  type RecordFailure,
  StepHost,
  type StepPlan,
} from "./plugins/step-host.ts"
