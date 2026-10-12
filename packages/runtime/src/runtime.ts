import { EventLog, eventsFor, extendSpecterConfig } from "@specter-ts/core"
import { makeSpecterRuntime } from "@specter-ts/core/effect"
import { createMemoryReactionOutboxStore, type OutboxedReaction } from "@specter-ts/reaction-outbox"
import { Effect } from "effect"

import {
  createRuntimeConfig,
  createSliceStoreLayer,
  type DriveExecutionOutboxStore,
  memorySliceStoreLayer,
  type ProvideSliceStore,
  type RunStepOutboxOptions,
  type RunStepOutboxStore,
  runtimeConfig,
} from "./app.ts"
import type { RunStepRequest } from "./features/session/run-step-reaction/impl.ts"
import { recordHistory } from "./features/testing/record-history/impl.ts"
import { StepHost } from "./plugins/step-host.ts"

// OC++'s one runtime, embedded in its host process: every Command, Query and
// Reaction over the Event Log the host provides (OC++ keeps it in its own
// database and projects each commit as its own events in the same
// transaction).
export type RuntimeOptions = {
  // The step outbox's worker, including how many Sessions run steps at once.
  readonly outbox?: RunStepOutboxOptions
  // Where the runtime keeps its own state. In memory by default, so each
  // boot folds the whole log and replays every Reaction over it (replayed
  // Commands are idempotent). A host that persists them boots from where it
  // stopped: Slice states from their cursors, and outboxed jobs, which dedupe
  // a replayed Reaction's output.
  readonly stores?: {
    readonly slices?: ProvideSliceStore
    readonly runStep?: RunStepOutboxStore
    readonly drive?: DriveExecutionOutboxStore
  }
  // Catch every Slice up to the log at boot, instead of each Command and
  // Query Slice when it is first used. Slices then hold the log's state as soon as the runtime is
  // up, which a host that saves them can check against a fold of the log.
  readonly catchUp?: boolean
  // Tests only: registers recordHistory, which records facts as given, so a
  // test can set up the history Commands would have recorded. Production
  // never makes the runtime with it, so nothing there can record a fact
  // without its Command.
  readonly history?: boolean
}

// Requires the EventLog service, which purges (a deleted Session's facts go),
// and a Scope. Commands and Queries work as soon as the runtime is made; its
// Reactions start when the host starts them with its step I/O. A host whose
// step I/O depends on services that depend on the runtime (OC++'s does: its
// Bus records through the runtime) makes the runtime first, composes the rest,
// and then starts it.
export const makeRuntime = (options: RuntimeOptions = {}) =>
  Effect.gen(function* () {
    const log = yield* EventLog
    // A test's runtime registers recordHistory beside the production Slices; the production config's type never
    // names it, and only a test's fixture dispatches it.
    const config = extendSpecterConfig(
      createRuntimeConfig({
        runStep: options.stores?.runStep ?? createMemoryReactionOutboxStore<OutboxedReaction<RunStepRequest>>(),
        ...(options.outbox === undefined ? {} : { outbox: options.outbox }),
        ...(options.stores?.drive === undefined ? {} : { drive: options.stores.drive }),
      }),
      options.history ? { slices: { recordHistory } } : {},
    )
    // Conformance wants every registered Event covered by a scenario, and
    // some of the catalog is not decided by any Slice: register the events the
    // Slices use.
    const events = [
      ...new Map(
        Object.values(config.slices)
          .flatMap((slice) => eventsFor(slice, config.events))
          .map((definition) => [definition.type, definition]),
      ).values(),
    ]
    // Reactions are held until the host starts them: until then a Command's
    // `reactions` completes at once, and no step job runs, those the last
    // process left unfinished included.
    const app = yield* makeSpecterRuntime(
      { slices: config.slices, events },
      { reactions: "deferred", requires: { purge: true }, ...(options.catchUp ? { catchUp: "all" } : {}) },
    ).pipe(
      Effect.provide(options.stores?.slices ? createSliceStoreLayer(options.stores.slices) : memorySliceStoreLayer),
    )
    return {
      command: app.command,
      query: app.query,
      subscribe: app.subscribe,
      // Starts the Reactions with the host's step I/O: their Plugins read it
      // (and the purge's, the Event Log), they catch up with the log, as at a
      // boot, and run for every commit after.
      start: (stepHost: StepHost["Service"]) =>
        app.start.pipe(Effect.provideService(StepHost, stepHost), Effect.provideService(EventLog, log)),
    }
  })

export type Runtime = Effect.Success<ReturnType<typeof makeRuntime>>

// The names of the Slices a runtime made with these options serves: a host that saves their snapshots removes
// those of any other Slice, which nothing serves any more.
export const servedSlices = (options: Pick<RuntimeOptions, "history"> = {}): readonly string[] => [
  ...Object.keys(runtimeConfig.slices),
  ...(options.history ? [recordHistory.name] : []),
]
