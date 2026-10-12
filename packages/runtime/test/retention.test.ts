import { EventLog, type SliceSnapshot } from "@specter-ts/core"
import { createMemoryEventLog, createSnapshotSliceStores } from "@specter-ts/memory"
import { Effect, type Scope } from "effect"
import { describe, expect, it } from "bun:test"

import { sessionFacts } from "../src/features/facts.ts"
import { StepHost } from "../src/plugins/step-host.ts"
import { makeRuntime } from "../src/runtime.ts"

const run = <A>(program: Effect.Effect<A, unknown, Scope.Scope>) => Effect.runPromise(Effect.scoped(program))

type Log = ReturnType<typeof createMemoryEventLog>
type Fact = { readonly type: string; readonly payload: unknown }

// A host whose steps never begin: the runtime's Reactions fold every commit
// and request their jobs, which wait until the runtime closes.
const idleHost = StepHost.of({
  begin: () => Effect.never,
  compact: () => Effect.never,
})

// Every fact OC++ records about a Session, once each, with the Session's own
// identities: its ID, and the IDs of its messages, executions, shells, calls
// and notifications. A parent is a Session the log never created.
const historyOf = (sessionID: string) => {
  const own = (value: unknown, key?: string): unknown => {
    if (key === "sessionID") return sessionID
    if (key === "parentID" || key === "parentSessionID") return `ses_parent${sessionID.slice(4)}`
    if (typeof value === "string")
      return /^(msg|exe|sh|call|vendor|detached|job)[_-]/.test(value) ? `${value}${sessionID.slice(4)}` : value
    if (Array.isArray(value)) return value.map((item) => own(item))
    if (typeof value === "object" && value !== null)
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, own(item, name)]))
    return value
  }
  return Object.entries(sessionFacts)
    .filter(([type, payload]) => type !== "session-deleted" && "sessionID" in payload)
    .map(([type, payload]) => ({ type, payload: own(payload) }))
}

const sessions = ["ses_retainA", "ses_retainB", "ses_retainC"]

// Each Slice's State as its snapshot holds it, by Slice.
const states = (snapshots: readonly SliceSnapshot[]) =>
  Object.fromEntries(snapshots.map((snapshot) => [snapshot.slice, snapshot.state]))

// A runtime booted over a log, every Slice caught up with it and its
// Reactions run through it; the State each Slice holds then.
const fold = (log: Log) =>
  Effect.scoped(
    Effect.gen(function* () {
      const stores = createSnapshotSliceStores()
      const runtime = yield* makeRuntime({ catchUp: true, history: true, stores: { slices: stores.layer } }).pipe(
        Effect.provideService(EventLog, log),
      )
      yield* runtime.start(idleHost)
      return states(stores.snapshot())
    }),
  )

// A State as JSON with its records' keys sorted: a fold of tombstones alone
// adds a tombstone where the full log's fold had the Session's entry, so the
// same records may list their keys in another order.
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value

// The Slices whose States differ between two folds.
const differing = (left: Record<string, unknown>, right: Record<string, unknown>) =>
  [...new Set([...Object.keys(left), ...Object.keys(right)])].filter(
    (slice) => JSON.stringify(canonical(left[slice])) !== JSON.stringify(canonical(right[slice])),
  )

// A runtime over a log, for a test's Commands.
const runtimeOver = (log: Log) => makeRuntime({ history: true }).pipe(Effect.provideService(EventLog, log))
type Runtime = Effect.Success<ReturnType<typeof runtimeOver>>

const record = (runtime: Runtime, facts: readonly Fact[]) =>
  runtime.command({ type: "recordHistory", payload: { facts } } as never)

const remove = (runtime: Runtime, sessionID: string) =>
  runtime.command({ type: "deleteSession", payload: { sessionID } })

describe("a deleted Session in the runtime's State", () => {
  it("is forgotten by every Slice but for its tombstone", () =>
    run(
      Effect.gen(function* () {
        // Sessions with every kind of activity, then deleted.
        const full = createMemoryEventLog()
        const runtime = yield* runtimeOver(full)
        for (const sessionID of sessions) {
          yield* record(runtime, historyOf(sessionID))
          yield* remove(runtime, sessionID)
        }
        // The same Sessions as their tombstones alone give them.
        const tombstones = createMemoryEventLog()
        const recorder = yield* runtimeOver(tombstones)
        yield* record(
          recorder,
          sessions.map((sessionID) => ({ type: "session-deleted", payload: { sessionID } })),
        )

        const folded = yield* fold(full)
        const forgotten = yield* fold(tombstones)
        expect(Object.keys(folded).length).toBeGreaterThan(80)
        expect(Object.keys(forgotten).sort()).toEqual(Object.keys(folded).sort())
        expect(differing(folded, forgotten)).toEqual([])
      }),
    ))
})
