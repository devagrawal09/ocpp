import { createMemorySliceStoreLayer } from "@specter-ts/memory"
import {
  createMemoryReactionOutboxStore,
  type OutboxedReaction,
  type ReactionOutboxPluginOptions,
  type ReactionOutboxStore,
  withReactionOutbox,
} from "@specter-ts/reaction-outbox"
import type { SliceStoreService, SliceStoreTag } from "@specter-ts/core"
import { Effect, Layer } from "effect"

import { sessionEventDefinitions } from "./events.ts"
import { makeDriveExecutionPlugin } from "./plugins/drive-execution.ts"
import { makeRunStepPlugin } from "./plugins/run-step.ts"
import type { StepHost } from "./plugins/step-host.ts"
import { clearRevert, clearRevertStore, createClearRevertState } from "./features/session/clear-revert/impl.ts"
import { commitRevert, commitRevertStore, createCommitRevertState } from "./features/session/commit-revert/impl.ts"
import { createCreateSessionState, createSession, createSessionStore } from "./features/session/create-session/impl.ts"
import { createDeleteSessionState, deleteSession, deleteSessionStore } from "./features/session/delete-session/impl.ts"
import { createForkSessionState, forkSession, forkSessionStore } from "./features/session/fork-session/impl.ts"
import { createMoveSessionState, moveSession, moveSessionStore } from "./features/session/move-session/impl.ts"
import { createStageRevertState, stageRevert, stageRevertStore } from "./features/session/stage-revert/impl.ts"
import {
  createResolveWorktreeState,
  resolveWorktree,
  resolveWorktreeStore,
} from "./features/project/resolve-worktree/impl.ts"
import {
  createBindExternalAgentState,
  bindExternalAgent,
  bindExternalAgentStore,
} from "./features/session/bind-external-agent/impl.ts"
import {
  createLinkVendorSessionState,
  linkVendorSession,
  linkVendorSessionStore,
} from "./features/session/link-vendor-session/impl.ts"
import {
  createCheckpointVendorSessionState,
  checkpointVendorSession,
  checkpointVendorSessionStore,
} from "./features/session/checkpoint-vendor-session/impl.ts"
import { createRunShellState, runShell, runShellStore } from "./features/session/run-shell/impl.ts"
import { createSettleShellState, settleShell, settleShellStore } from "./features/session/settle-shell/impl.ts"
import {
  createStartCompactionState,
  startCompaction,
  startCompactionStore,
} from "./features/session/start-compaction/impl.ts"
import {
  createSettleCompactionState,
  settleCompaction,
  settleCompactionStore,
} from "./features/session/settle-compaction/impl.ts"
import {
  createUpdateInstructionsState,
  updateInstructions,
  updateInstructionsStore,
} from "./features/session/update-instructions/impl.ts"
import {
  createSetInstructionEntryState,
  setInstructionEntry,
  setInstructionEntryStore,
} from "./features/session/set-instruction-entry/impl.ts"
import {
  createRemoveInstructionEntryState,
  removeInstructionEntry,
  removeInstructionEntryStore,
} from "./features/session/remove-instruction-entry/impl.ts"
import { createRenameSessionState, renameSession, renameSessionStore } from "./features/session/rename-session/impl.ts"
import { createSelectAgentState, selectAgent, selectAgentStore } from "./features/session/select-agent/impl.ts"
import { createSelectModelState, selectModel, selectModelStore } from "./features/session/select-model/impl.ts"
import { createSelectToolsState, selectTools, selectToolsStore } from "./features/session/select-tools/impl.ts"
import { createViewSessionState, viewSession, viewSessionStore } from "./features/session/view-session/impl.ts"
import { createDisplayResultState, displayResult, displayResultStore } from "./features/session/display-result/impl.ts"
import { createRecordUsageState, recordUsage, recordUsageStore } from "./features/session/record-usage/impl.ts"
import { createEditMessageState, editMessage, editMessageStore } from "./features/session/edit-message/impl.ts"
import { createActivateSkillState, activateSkill, activateSkillStore } from "./features/session/activate-skill/impl.ts"
import {
  createAppendSyntheticState,
  appendSynthetic,
  appendSyntheticStore,
} from "./features/session/append-synthetic/impl.ts"
import {
  createDriveExecution,
  createDriveExecutionState,
  type DriveExecutionRequest,
  driveExecutionStore,
} from "./features/session/drive-execution-reaction/impl.ts"
import { createFailExecutionState, failExecution, failExecutionStore } from "./features/session/fail-execution/impl.ts"
import {
  createFinishExecutionState,
  finishExecution,
  finishExecutionStore,
} from "./features/session/finish-execution/impl.ts"
import {
  createRecordStepStartedState,
  recordStepStarted,
  recordStepStartedStore,
} from "./features/session/record-step-started/impl.ts"
import {
  createRecordStepStreamedState,
  recordStepStreamed,
  recordStepStreamedStore,
} from "./features/session/record-step-streamed/impl.ts"
import { createRecordBlockState, recordBlock, recordBlockStore } from "./features/session/record-block/impl.ts"
import {
  createRecordToolCallState,
  recordToolCall,
  recordToolCallStore,
} from "./features/session/record-tool-call/impl.ts"
import {
  createSettleToolCallState,
  settleToolCall,
  settleToolCallStore,
} from "./features/session/settle-tool-call/impl.ts"
import { createFailToolInputState, failToolInput, failToolInputStore } from "./features/session/fail-tool-input/impl.ts"
import { createSettleStepState, settleStep, settleStepStore } from "./features/session/settle-step/impl.ts"
import {
  createRunStep,
  createRunStepState,
  runStepStore,
  type RunStepRequest,
} from "./features/session/run-step-reaction/impl.ts"
import {
  changeDelivery,
  changeDeliveryStore,
  createChangeDeliveryState,
} from "./features/session/change-delivery/impl.ts"
import {
  cancelInboxItem,
  cancelInboxItemStore,
  createCancelInboxItemState,
} from "./features/session/cancel-inbox-item/impl.ts"
import { enqueueInput, enqueueInputStore, createEnqueueInputState } from "./features/session/enqueue-input/impl.ts"
import {
  createNextDeliverableState,
  nextDeliverable,
  nextDeliverableStore,
} from "./features/session/next-deliverable-query/impl.ts"
import {
  createDeliverInboxItemState,
  deliverInboxItem,
  deliverInboxItemStore,
} from "./features/session/deliver-inbox-item/impl.ts"
import {
  createSessionStatusState,
  sessionStatus,
  sessionStatusStore,
} from "./features/session/session-status-query/impl.ts"
import {
  activeSessions,
  activeSessionsStore,
  createActiveSessionsState,
} from "./features/session/active-sessions-query/impl.ts"
import {
  createInterruptExecutionState,
  interruptExecution,
  interruptExecutionStore,
} from "./features/session/interrupt-execution/impl.ts"
import {
  createRecordSessionFactsState,
  recordSessionFacts,
  recordSessionFactsStore,
} from "./features/session/record-session-facts/impl.ts"
import {
  createStartExecutionState,
  startExecution,
  startExecutionStore,
} from "./features/session/start-execution/impl.ts"
import {
  createWakeExecutionState,
  wakeExecution,
  wakeExecutionStore,
} from "./features/session/wake-execution-reaction/impl.ts"

export type RunStepOutboxStore = ReactionOutboxStore<OutboxedReaction<RunStepRequest>>
export type DriveExecutionOutboxStore = ReactionOutboxStore<OutboxedReaction<DriveExecutionRequest>>

// Worker tuning (concurrency, lease, heartbeat, backoff, shutdown wait) for the
// step Plugin's outbox; defaults are the outbox's own. Steps are keyed by
// Session: one Session runs one step at a time, and with a worker concurrency
// above 1, different Sessions run at once.
export type RunStepOutboxOptions = Omit<ReactionOutboxPluginOptions<RunStepRequest>, "store" | "concurrencyKey">

// Every OC++ Command, Query and Reaction, in one config over one Event Log.
// The step and drive Reactions' Plugins are outboxed, so the composing app
// supplies their outbox stores (memory in tests; a persistent store when the
// Event Log is). `host` is the host's step I/O, which each of their jobs
// resolves before it starts.
export const createRuntimeConfig = (options: {
  readonly host: Effect.Effect<StepHost["Service"]>
  readonly runStep: RunStepOutboxStore
  readonly outbox?: RunStepOutboxOptions
  // An external agent's executions, which the host drives whole.
  readonly drive?: DriveExecutionOutboxStore
}) =>
  ({
    events: sessionEventDefinitions,
    slices: {
      recordSessionFacts,
      createSession,
      forkSession,
      moveSession,
      deleteSession,
      stageRevert,
      clearRevert,
      commitRevert,
      renameSession,
      selectAgent,
      selectModel,
      selectTools,
      viewSession,
      displayResult,
      recordUsage,
      editMessage,
      activateSkill,
      appendSynthetic,
      updateInstructions,
      setInstructionEntry,
      removeInstructionEntry,
      runShell,
      settleShell,
      startCompaction,
      settleCompaction,
      bindExternalAgent,
      linkVendorSession,
      checkpointVendorSession,
      resolveWorktree,
      enqueueInput,
      cancelInboxItem,
      changeDelivery,
      nextDeliverable,
      deliverInboxItem,
      startExecution,
      interruptExecution,
      wakeExecution,
      sessionStatus,
      activeSessions,
      recordStepStarted,
      recordStepStreamed,
      settleStep,
      recordBlock,
      recordToolCall,
      settleToolCall,
      failToolInput,
      finishExecution,
      failExecution,
      runStep: createRunStep(
        withReactionOutbox(makeRunStepPlugin(options.host), {
          // A step can run for minutes: shutdown stops it instead of waiting,
          // and the next run settles the step it left started.
          interruptOnShutdown: true,
          ...options.outbox,
          store: options.runStep,
          concurrencyKey: (request) => request.payload.sessionID,
        }),
      ),
      driveExecution: createDriveExecution(
        withReactionOutbox(makeDriveExecutionPlugin(options.host), {
          // An agent's turn can run for minutes too.
          interruptOnShutdown: true,
          // As many Sessions at once as the step outbox runs.
          ...(options.outbox?.worker?.concurrency === undefined
            ? {}
            : { worker: { concurrency: options.outbox.worker.concurrency } }),
          store: options.drive ?? createMemoryReactionOutboxStore(),
          concurrencyKey: (request) => request.payload.sessionID,
        }),
      ),
    },
  }) as const

// Used by the per-Slice scenario tests, which never run Plugins; the
// integration test builds its own config around an outbox store it inspects.
export const runtimeConfig = createRuntimeConfig({
  host: Effect.die(new Error("Scenario tests run no step")),
  runStep: createMemoryReactionOutboxStore(),
})

// Every Slice owns its own projection store; an adapter composition supplies
// how one store is provided (memory here, snapshots in snapshots.ts, JSONL in
// test/fixture/jsonl-runtime.ts).
export type ProvideSliceStore = <TIdentifier, TWriteState, TReadState>(
  tag: SliceStoreTag<TIdentifier, SliceStoreService<TReadState, TWriteState, unknown>>,
  createState: () => TWriteState,
) => Layer.Layer<TIdentifier>

export const createSliceStoreLayer = (provide: ProvideSliceStore) =>
  Layer.mergeAll(
    provide(recordSessionFactsStore, createRecordSessionFactsState),
    provide(createSessionStore, createCreateSessionState),
    provide(forkSessionStore, createForkSessionState),
    provide(moveSessionStore, createMoveSessionState),
    provide(deleteSessionStore, createDeleteSessionState),
    provide(stageRevertStore, createStageRevertState),
    provide(clearRevertStore, createClearRevertState),
    provide(commitRevertStore, createCommitRevertState),
    provide(renameSessionStore, createRenameSessionState),
    provide(selectAgentStore, createSelectAgentState),
    provide(selectModelStore, createSelectModelState),
    provide(selectToolsStore, createSelectToolsState),
    provide(viewSessionStore, createViewSessionState),
    provide(displayResultStore, createDisplayResultState),
    provide(recordUsageStore, createRecordUsageState),
    provide(editMessageStore, createEditMessageState),
    provide(activateSkillStore, createActivateSkillState),
    provide(appendSyntheticStore, createAppendSyntheticState),
    provide(updateInstructionsStore, createUpdateInstructionsState),
    provide(setInstructionEntryStore, createSetInstructionEntryState),
    provide(removeInstructionEntryStore, createRemoveInstructionEntryState),
    provide(runShellStore, createRunShellState),
    provide(settleShellStore, createSettleShellState),
    provide(startCompactionStore, createStartCompactionState),
    provide(settleCompactionStore, createSettleCompactionState),
    provide(bindExternalAgentStore, createBindExternalAgentState),
    provide(linkVendorSessionStore, createLinkVendorSessionState),
    provide(checkpointVendorSessionStore, createCheckpointVendorSessionState),
    provide(resolveWorktreeStore, createResolveWorktreeState),
    provide(enqueueInputStore, createEnqueueInputState),
    provide(cancelInboxItemStore, createCancelInboxItemState),
    provide(changeDeliveryStore, createChangeDeliveryState),
    provide(nextDeliverableStore, createNextDeliverableState),
    provide(deliverInboxItemStore, createDeliverInboxItemState),
    provide(startExecutionStore, createStartExecutionState),
    provide(interruptExecutionStore, createInterruptExecutionState),
    provide(wakeExecutionStore, createWakeExecutionState),
    provide(sessionStatusStore, createSessionStatusState),
    provide(activeSessionsStore, createActiveSessionsState),
    provide(recordStepStartedStore, createRecordStepStartedState),
    provide(recordStepStreamedStore, createRecordStepStreamedState),
    provide(settleStepStore, createSettleStepState),
    provide(recordBlockStore, createRecordBlockState),
    provide(recordToolCallStore, createRecordToolCallState),
    provide(settleToolCallStore, createSettleToolCallState),
    provide(failToolInputStore, createFailToolInputState),
    provide(finishExecutionStore, createFinishExecutionState),
    provide(failExecutionStore, createFailExecutionState),
    provide(runStepStore, createRunStepState),
    provide(driveExecutionStore, createDriveExecutionState),
  )

// Fresh in-memory state per Layer scope.
export const memorySliceStoreLayer = createSliceStoreLayer(createMemorySliceStoreLayer)
