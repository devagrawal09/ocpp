import { eventsFor, testSliceImplementation } from "@specter-ts/core/testing"
import { Effect } from "effect"

import { memorySliceStoreLayer, runtimeConfig } from "../src/app.ts"
import { recordHistory } from "../src/features/testing/record-history/impl.ts"

// The full session catalog has 49 events and only three slices exist so far,
// so each Slice is tested against the events its scenarios and apply handlers
// need (eventsFor), not the whole-app catalog.
// recordHistory is registered only in a runtime made for tests, but it is
// specified like every Slice.
for (const slice of [...Object.values(runtimeConfig.slices), recordHistory]) {
  testSliceImplementation(slice, {
    events: eventsFor(slice, runtimeConfig.events),
    // Fresh in-memory Slice stores per scenario.
    runScenario: (program) =>
      Effect.runPromise(program.pipe(Effect.provide(memorySliceStoreLayer)) as Effect.Effect<never, unknown, never>),
  })
}
