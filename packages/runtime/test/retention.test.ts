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

// A runtime booted over a log, from saved snapshots or from nothing, every
// Slice caught up with it and its Reactions run through it; its Slices'
// snapshots then. The boot purges nothing, so a log kept whole stays whole.
const boot = (log: Log, saved: readonly SliceSnapshot[] = []) =>
  Effect.scoped(
    Effect.gen(function* () {
      const stores = createSnapshotSliceStores(saved)
      const runtime = yield* makeRuntime({ catchUp: true, history: true, stores: { slices: stores.layer } }).pipe(
        Effect.provideService(EventLog, { ...log, purge: () => Effect.succeed({ purged: 0 }) }),
      )
      yield* runtime.start(idleHost)
      return stores.snapshot()
    }),
  )

// The State each Slice holds after such a boot: a Slice that did not move
// holds what it was saved with.
const fold = (log: Log, saved: readonly SliceSnapshot[] = []) =>
  boot(log, saved).pipe(Effect.map((snapshots) => ({ ...states(saved), ...states(snapshots) })))

// A State as JSON with its records' keys sorted: a fold of a purged log adds a
// tombstone where the full log's fold had the Session's entry, so the same
// records may list their keys in another order.
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

// A runtime over a log, for a test's Commands; started, it purges what it deletes.
const runtimeOver = (log: Log) => makeRuntime({ history: true }).pipe(Effect.provideService(EventLog, log))
type Runtime = Effect.Success<ReturnType<typeof runtimeOver>>

const record = (runtime: Runtime, facts: readonly Fact[]) =>
  runtime.command({ type: "recordHistory", payload: { facts } } as never)

// Deletes a Session, and waits for what its deletion runs (its purge, on a started runtime).
const remove = (runtime: Runtime, sessionID: string) =>
  runtime.command({ type: "deleteSession", payload: { sessionID } }).pipe(Effect.flatMap((result) => result.reactions))

const typesOf = (log: Log, key: { readonly name: string; readonly value: string }) =>
  log.readKey(key).pipe(Effect.map((events) => events.map((event) => event.type)))

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

describe("a deleted Session in the log", () => {
  it("is purged but for its tombstone, with the aggregates it owns, and the purged log folds the same", () =>
    run(
      Effect.gen(function* () {
        // One log the runtime purges, and one it never does: the same Commands over each.
        const purged = createMemoryEventLog()
        const runtime = yield* runtimeOver(purged)
        yield* runtime.start(idleHost)
        const kept = createMemoryEventLog()
        const unpurged = yield* runtimeOver(kept)
        for (const sessionID of sessions) {
          yield* record(runtime, historyOf(sessionID))
          yield* record(unpurged, historyOf(sessionID))
        }
        // What the deletion ends: a Code Mode run with a call, and a background job, both still running.
        const running: Fact[] = [
          "session-codemode-execution-admitted",
          "session-codemode-execution-started",
          "session-codemode-call-scheduled",
          "session-background-started",
        ].map((type) => ({
          type,
          payload: {
            ...sessionFacts[type as keyof typeof sessionFacts],
            sessionID: "ses_retainA",
            ...(type === "session-background-started"
              ? { notificationID: "msg_runningretainA", jobID: "exe_runningretainA" }
              : { executionID: "exe_runningretainA" }),
          },
        }))
        yield* record(runtime, running)
        yield* record(unpurged, running)
        // Slices saved before the deletion, which the purge leaves behind.
        const length = kept.inspect().length
        const saved = yield* boot(purged)
        yield* boot(kept)
        expect(kept.inspect()).toHaveLength(length)
        yield* remove(runtime, "ses_retainA")
        yield* remove(unpurged, "ses_retainA")

        // Its facts go, but for its deletion; so do those of its Code Mode run, its inbox item and its
        // background job's marker, and the Sessions left are untouched.
        expect(yield* typesOf(purged, { name: "session", value: "ses_retainA" })).toEqual(["session-deleted"])
        for (const key of [
          { name: "execution", value: "exe_1retainA" },
          { name: "inbox", value: "msg_firstretainA" },
          { name: "notification", value: "msg_3retainA" },
        ])
          expect(yield* typesOf(purged, key)).toEqual([])
        expect((yield* typesOf(kept, { name: "notification", value: "msg_3retainA" })).length).toBeGreaterThan(0)
        for (const sessionID of ["ses_retainB", "ses_retainC"])
          expect(yield* typesOf(purged, { name: "session", value: sessionID })).toEqual(
            yield* typesOf(kept, { name: "session", value: sessionID }),
          )

        // A boot from what is left holds what a boot from everything holds, and so does one from Slices saved
        // before the deletion, which catch up with the purged log.
        const whole = yield* fold(kept)
        expect(differing(yield* fold(purged), whole)).toEqual([])
        expect(differing(yield* fold(purged, saved), whole)).toEqual([])

        // Purged again, nothing changes; and its ID stays refused.
        const left = purged.inspect().length
        yield* remove(runtime, "ses_retainA").pipe(Effect.flip)
        expect(purged.inspect()).toHaveLength(left)
      }),
    ))

  it("keeps what a fork's notebook copy reads of its parent until the fork is purged too", () =>
    run(
      Effect.gen(function* () {
        const created = (sessionID: string) => ({
          type: "session-created",
          payload: { ...sessionFacts["session-created"], sessionID },
        })
        const parent: Fact[] = [
          created("ses_parent"),
          {
            type: "session-codemode-execution-settled",
            payload: { ...sessionFacts["session-codemode-execution-settled"], sessionID: "ses_parent" },
          },
          {
            type: "session-codemode-command-defined",
            payload: { ...sessionFacts["session-codemode-command-defined"], sessionID: "ses_parent" },
          },
          {
            type: "session-codemode-event-defined",
            payload: { ...sessionFacts["session-codemode-event-defined"], sessionID: "ses_parent" },
          },
          {
            type: "session-renamed",
            payload: { ...sessionFacts["session-renamed"], sessionID: "ses_parent" },
          },
        ]
        const fork: Fact[] = [
          created("ses_fork"),
          {
            type: "session-codemode-notebook-copied",
            payload: { sessionID: "ses_fork", parentID: "ses_parent", executions: ["exe_1"] },
          },
          {
            type: "session-forked",
            payload: { ...sessionFacts["session-forked"], sessionID: "ses_fork", parentID: "ses_parent" },
          },
        ]
        const purged = createMemoryEventLog()
        const runtime = yield* runtimeOver(purged)
        yield* runtime.start(idleHost)
        const kept = createMemoryEventLog()
        const unpurged = yield* runtimeOver(kept)
        for (const recorder of [runtime, unpurged]) {
          yield* record(recorder, parent)
          yield* record(recorder, fork)
        }

        // The parent goes first: what the fork's copy read of it stays, beside its tombstone.
        yield* remove(runtime, "ses_parent")
        yield* remove(unpurged, "ses_parent")
        expect(yield* typesOf(purged, { name: "session", value: "ses_parent" })).toEqual([
          "session-codemode-execution-settled",
          "session-codemode-command-defined",
          "session-codemode-event-defined",
          "session-deleted",
        ])
        const folded = yield* fold(purged)
        expect(differing(folded, yield* fold(kept))).toEqual([])
        expect(folded["settleCodeModeExecution"]).toMatchObject({ notebooks: { ses_fork: { report: {} } } })
        expect(folded["removeCodeModeCommand"]).toMatchObject({ commands: { ses_fork: { deploy: true } } })
        expect(folded["toggleCodeModeEvent"]).toMatchObject({ events: { ses_fork: { nightly: true } } })

        // Then the fork: its purge frees the parent's, and only tombstones are left.
        yield* remove(runtime, "ses_fork")
        yield* remove(unpurged, "ses_fork")
        for (const sessionID of ["ses_parent", "ses_fork"])
          expect(yield* typesOf(purged, { name: "session", value: sessionID })).toEqual(["session-deleted"])
        expect(differing(yield* fold(purged), yield* fold(kept))).toEqual([])
      }),
    ))
})
