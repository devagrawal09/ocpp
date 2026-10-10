import { eventsFor, ReactionScheduler, type ReactionExecutor, type ReactionSchedulerService } from "@specter-ts/core"
import { makeSpecterRuntime } from "@specter-ts/core/effect"
import { createMemoryReactionOutboxStore, type OutboxedReaction } from "@specter-ts/reaction-outbox"
import { Deferred, Effect, Layer, Semaphore } from "effect"

import {
  createRuntimeConfig,
  createSliceStoreLayer,
  type DriveExecutionOutboxStore,
  memorySliceStoreLayer,
  type ProvideSliceStore,
  type RunStepOutboxOptions,
  type RunStepOutboxStore,
} from "./app.ts"
import type { RunStepRequest } from "./features/session/run-step-reaction/impl.ts"
import type { StepHost } from "./plugins/step-host.ts"

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
}

// Requires the EventLog service and a Scope. Commands and Queries work as soon
// as the runtime is made; its Reactions start when the host starts them with
// its step I/O. A host whose step I/O depends on services that depend on the
// runtime (OC++'s does: its Bus records through the runtime) makes the
// runtime first, composes the rest, and then starts it.
export const makeRuntime = (options: RuntimeOptions = {}) =>
  Effect.gen(function* () {
    const host = yield* Deferred.make<StepHost["Service"]>()
    const reactions = gatedReactions()
    const config = createRuntimeConfig({
      host: Deferred.await(host),
      runStep: options.stores?.runStep ?? createMemoryReactionOutboxStore<OutboxedReaction<RunStepRequest>>(),
      ...(options.outbox === undefined ? {} : { outbox: options.outbox }),
      ...(options.stores?.drive === undefined ? {} : { drive: options.stores.drive }),
    })
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
    const app = yield* makeSpecterRuntime({ ...config, events }, options.catchUp ? { catchUp: "all" } : {}).pipe(
      Effect.provide(
        Layer.mergeAll(
          options.stores?.slices ? createSliceStoreLayer(options.stores.slices) : memorySliceStoreLayer,
          Layer.succeed(ReactionScheduler, reactions.scheduler),
        ),
      ),
    )
    return {
      command: app.command,
      query: app.query,
      subscribe: app.subscribe,
      // Binds the host's step I/O and starts the Reactions: they catch up
      // with the log, as at a boot, and run for every commit after. Outboxed
      // jobs wait for it, those the last process left unfinished included.
      start: (stepHost: StepHost["Service"]) => Deferred.succeed(host, stepHost).pipe(Effect.andThen(reactions.start)),
    }
  })

export type Runtime = Effect.Success<ReturnType<typeof makeRuntime>>

// The immediate scheduler, held until the host starts the Reactions. Until
// then it only remembers how far the log has gone, and a Command's
// `reactions` completes at once. Starting runs every Reaction through that
// point; later commits each run when they land, one run at a time.
const gatedReactions = () => {
  const permit = Semaphore.makeUnsafe(1)
  const state: { execute?: ReactionExecutor<unknown>; through: number; started: boolean } = {
    through: 0,
    started: false,
  }
  const run = (throughOrder: number) =>
    Effect.suspend(() =>
      state.execute
        ? permit.withPermit(state.execute({ throughOrder, scheduledAt: new Date().toISOString() }))
        : Effect.void,
    )
  const scheduler: ReactionSchedulerService = {
    bind: <E>(binding: { readonly execute: ReactionExecutor<E> }) =>
      Effect.sync(() => {
        state.execute = binding.execute
        return {
          schedule: (throughOrder: number) =>
            Effect.sync(() => {
              // The executor run is the one bound here, so it fails as E does.
              if (state.started) return run(throughOrder) as Effect.Effect<void, E>
              state.through = Math.max(state.through, throughOrder)
              return Effect.void
            }),
        }
      }),
  }
  const start = Effect.suspend(() => {
    if (state.started) return Effect.void
    state.started = true
    return run(state.through)
  })
  return { scheduler, start }
}
