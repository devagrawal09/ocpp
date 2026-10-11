import { EventLog } from "@specter-ts/core"
import { createMemoryEventLog } from "@specter-ts/memory"
import { Effect, type Scope } from "effect"
import { describe, expect, it } from "bun:test"

import { makeRuntime, type RuntimeOptions } from "../src/runtime.ts"
import { makeSnapshotSliceStores, type SliceSnapshot } from "../src/snapshots.ts"
import { makeScriptedStepHost } from "./fixture/scripted-step-host.ts"

const hostLog = () => {
  let next = 0
  return createMemoryEventLog({
    eventId: () => `evt_${String(++next).padStart(4, "0")}`,
  })
}

// The runtime as a host embeds it: over the host's Event Log, with the step
// I/O the host supplies.
const bootOver = (log: ReturnType<typeof hostLog>, options: RuntimeOptions = {}) =>
  Effect.gen(function* () {
    const host = makeScriptedStepHost({ agent: "plan" })
    const runtime = yield* makeRuntime(options).pipe(Effect.provideService(EventLog, log))
    yield* runtime.start(host.host)
    return { runtime, host, recorded: () => log.inspect() }
  })
const boot = Effect.suspend(() => bootOver(hostLog()))

const waitFor = (condition: () => boolean) =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 400 && !condition(); tries++) yield* Effect.sleep("5 millis")
    if (!condition()) return yield* Effect.die(new Error("Timed out"))
  })

const run = <A>(program: Effect.Effect<A, unknown, Scope.Scope>) => Effect.runPromise(Effect.scoped(program))

const creation = {
  type: "createSession" as const,
  payload: {
    session: {
      sessionID: "ses_1",
      projectID: "prj_1",
      location: { directory: "/tmp/ws" },
      slug: "brave-otter",
      version: "2",
    },
  },
}

describe("embedded runtime", () => {
  it("runs a session over the host Event Log", () =>
    run(
      Effect.gen(function* () {
        const { runtime, host, recorded } = yield* boot
        host.script("ses_1", [{ finish: "stop", text: "Hello" }])
        yield* runtime.command(creation)
        yield* runtime.command({
          type: "enqueueInput",
          payload: {
            sessionID: "ses_1",
            inboxID: "msg_in_1",
            type: "user",
            payload: { text: "Hi" },
          },
        })
        yield* waitFor(() => recorded().some((event) => event.type === "session-execution-settled"))

        expect(recorded().map((event) => event.type)).toEqual([
          "session-created",
          "session-inbox-enqueued",
          "session-execution-started",
          "session-inbox-delivered",
          "session-step-started",
          "session-block-recorded",
          "session-step-settled",
          "session-execution-settled",
        ])
        expect(recorded().map((event) => event.id)).toEqual(
          recorded().map((_, index) => `evt_${String(index + 1).padStart(4, "0")}`),
        )
        expect(recorded().at(-1)?.payload).toEqual({
          sessionID: "ses_1",
          outcome: "succeeded",
        })
        const step = recorded().find((event) => event.type === "session-step-started")
        expect(step?.payload).toMatchObject({
          assistantMessageID: "msg_ses_1_0",
          agent: "plan",
          model: { id: "scripted", providerID: "test" },
        })
      }),
    ))

  it("catches every Slice up at boot to the state a fold of the log gives", () =>
    run(
      Effect.gen(function* () {
        const log = hostLog()
        const bySlice = (snapshots: readonly SliceSnapshot[]) =>
          Object.fromEntries(
            snapshots.map((snapshot) => [snapshot.slice, { cursor: snapshot.cursor, state: snapshot.state }]),
          )
        // A Session runs to the end of its execution, and the host saves the
        // runtime's Slices.
        const first = makeSnapshotSliceStores([])
        const saved = yield* Effect.scoped(
          Effect.gen(function* () {
            const { runtime, host, recorded } = yield* bootOver(log, {
              catchUp: true,
              stores: { slices: first.provide },
            })
            host.script("ses_1", [{ finish: "stop", text: "Hello" }])
            yield* runtime.command(creation)
            yield* runtime.command({
              type: "enqueueInput",
              payload: {
                sessionID: "ses_1",
                inboxID: "msg_in_1",
                type: "user",
                payload: { text: "Hi" },
              },
            })
            yield* waitFor(() => recorded().some((event) => event.type === "session-execution-settled"))
            return first.snapshot()
          }),
        )
        const length = log.inspect().length

        // The next boot starts from them; another starts from the log alone.
        const resumed = makeSnapshotSliceStores(saved)
        yield* Effect.scoped(bootOver(log, { catchUp: true, stores: { slices: resumed.provide } }))
        const fromLog = makeSnapshotSliceStores([])
        yield* Effect.scoped(bootOver(log, { catchUp: true, stores: { slices: fromLog.provide } }))

        // Neither boot recorded anything, and both hold every Slice as the log
        // folds it.
        expect(log.inspect()).toHaveLength(length)
        const folded = bySlice(fromLog.snapshot())
        expect(Object.keys(folded).length).toBeGreaterThan(20)
        expect({ ...bySlice(saved), ...bySlice(resumed.snapshot()) }).toEqual(folded)
      }),
    ))

  it("holds Reactions until the host starts them, then catches them up with the log", () =>
    run(
      Effect.gen(function* () {
        const log = hostLog()
        const host = makeScriptedStepHost({ agent: "plan" })
        host.script("ses_1", [{ finish: "stop", text: "Hello" }])
        const runtime = yield* makeRuntime().pipe(Effect.provideService(EventLog, log))
        // Commands work before the start; the input they admit wakes nothing yet.
        yield* runtime.command(creation)
        const admitted = yield* runtime.command({
          type: "enqueueInput",
          payload: { sessionID: "ses_1", inboxID: "msg_in_1", type: "user", payload: { text: "Hi" } },
        })
        yield* admitted.reactions
        expect(log.inspect().map((event) => event.type)).toEqual(["session-created", "session-inbox-enqueued"])

        yield* runtime.start(host.host)
        yield* waitFor(() => log.inspect().some((event) => event.type === "session-execution-settled"))
        expect(log.inspect().map((event) => event.type)).toEqual([
          "session-created",
          "session-inbox-enqueued",
          "session-execution-started",
          "session-inbox-delivered",
          "session-step-started",
          "session-block-recorded",
          "session-step-settled",
          "session-execution-settled",
        ])
      }),
    ))

  it("refuses a second Session under one ID", () =>
    run(
      Effect.gen(function* () {
        const { runtime } = yield* boot
        yield* runtime.command(creation)
        const second = yield* Effect.flip(runtime.command(creation))
        expect(String(second)).toContain("Session already exists")
      }),
    ))
})

// S5a: Commands conflict only over what they decided on.
describe("concurrent Sessions", () => {
  const created = (sessionID: string) => ({
    type: "createSession" as const,
    payload: { session: { ...creation.payload.session, sessionID, slug: `slug-${sessionID}` } },
  })
  it("records many Sessions at once without exhausting the retries of a stale append", () =>
    run(
      Effect.gen(function* () {
        const log = hostLog()
        const runtime = yield* makeRuntime().pipe(Effect.provideService(EventLog, log))
        const sessions = Array.from({ length: 120 }, (_, index) => `ses_${String(index).padStart(3, "0")}`)
        yield* Effect.forEach(sessions, (sessionID) => runtime.command(created(sessionID)), {
          concurrency: "unbounded",
        })
        // Every Session records at once, some twice: each Command reads its
        // Session's folds, which every other Session's facts leave alone. A
        // compare-and-swap over the whole log, or over every Session's
        // renames, would make all but one of each round decide again, and
        // most would run out of retries.
        yield* Effect.forEach(
          sessions.flatMap((sessionID) => [
            { type: "renameSession" as const, payload: { sessionID, title: `${sessionID} first` } },
            {
              type: "appendSynthetic" as const,
              payload: { sessionID, text: "A note", description: "Note" },
            },
            { type: "renameSession" as const, payload: { sessionID, title: `${sessionID} second` } },
          ]),
          (command) => runtime.command(command),
          { concurrency: "unbounded" },
        )
        const count = (type: string) => log.inspect().filter((event) => event.type === type).length
        expect(count("session-created")).toBe(120)
        expect(count("session-renamed")).toBe(240)
        expect(count("session-synthetic")).toBe(120)
      }),
    ))
})
