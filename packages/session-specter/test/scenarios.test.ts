import { testSliceImplementations } from "@specter-ts/core/testing"
import { createMemorySliceStoreLayer } from "@specter-ts/memory"
import { Effect, Layer } from "effect"
import { createSessionDecision, DecisionStore } from "../src/commands"
import { sessionEvents } from "../src/events"
import { MessagesStore, StatusStore } from "../src/queries"
import { createRunTurnState, RunTurnStore } from "../src/run-turn"
import { sessionAppConfig } from "../src/session-app"

testSliceImplementations(sessionAppConfig.slices, {
  events: sessionEvents,
  // Fresh stores per Scenario; Scenarios exercise apply and handle, never the outboxed Plugin.
  runScenario: <T>(program: Effect.Effect<T, unknown, unknown>) =>
    Effect.runPromise(
      program.pipe(
        Effect.provide(
          Layer.mergeAll(
            createMemorySliceStoreLayer(DecisionStore, createSessionDecision),
            createMemorySliceStoreLayer(MessagesStore, () => ({ pending: {}, messages: [] })),
            createMemorySliceStoreLayer(StatusStore, () => ({
              created: false,
              running: null,
              queued: [],
              succeeded: 0,
              failed: 0,
            })),
            createMemorySliceStoreLayer(RunTurnStore, createRunTurnState),
          ),
        ),
      ) as Effect.Effect<T>,
    ),
})
