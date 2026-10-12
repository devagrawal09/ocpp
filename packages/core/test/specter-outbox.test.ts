import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { createSqliteReactionOutboxStore } from "@ocpp/runtime/sqlite"
import { type ReactionOutboxConformancePayload, reactionOutboxStoreConformance } from "@ocpp/runtime/testing"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { SpecterDatabase } from "@ocpp/core/specter/database"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))

const at = (ms: number) => new Date(ms)
const job = (id: string, concurrencyKey?: string, requested = 0) => ({
  id,
  idempotencyKey: id,
  ...(concurrencyKey === undefined ? {} : { concurrencyKey }),
  payload: { id },
  requestedAt: at(requested),
  availableAt: at(requested),
})
// One Reaction's queue of Specter's outbox on OC++'s database, as the Bus opens it.
const open = (queue = "runStep") =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return createSqliteReactionOutboxStore<{ readonly id: string }>(SpecterDatabase.make(db), { queue })
  })

describe("Specter outbox on OC++'s database", () => {
  it.effect("conforms to Specter's outbox Store contract, concurrency keys, lease renewal and wake-ups included", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* reactionOutboxStoreConformance(
        Effect.succeed(
          createSqliteReactionOutboxStore<ReactionOutboxConformancePayload>(SpecterDatabase.make(db), {
            queue: "conformance",
          }),
        ),
      )
    }),
  )

  it.effect("dedupes a delivery by its idempotency key, per Reaction", () =>
    Effect.gen(function* () {
      const steps = yield* open("runStep")
      const drives = yield* open("driveExecution")
      let wakes = 0
      steps.subscribe(() => wakes++)
      expect((yield* steps.enqueue(job("runStep:1", "s1"))).created).toBe(true)
      const again = yield* steps.enqueue({ ...job("runStep:1", "s1"), payload: { id: "replayed" } })
      expect(again.created).toBe(false)
      expect(again.job.payload).toEqual({ id: "runStep:1" })
      expect(wakes).toBe(1)
      expect((yield* drives.enqueue({ ...job("driveExecution:1"), idempotencyKey: "runStep:1" })).created).toBe(true)
      expect((yield* steps.list()).map((item) => item.id)).toEqual(["runStep:1"])
      expect((yield* drives.list()).map((item) => item.id)).toEqual(["driveExecution:1"])
    }),
  )

  it.effect("releases what the last process left unfinished when a boot opens it", () =>
    Effect.gen(function* () {
      const before = yield* open()
      yield* before.enqueue(job("running", "s1", 1))
      yield* before.enqueue(job("dead", "s2", 2))
      yield* before.enqueue(job("done", "s3", 3))
      const running = (yield* before.claimNext(at(10), at(Date.now() + 60_000)))!
      const dead = (yield* before.claimNext(at(10), at(Date.now() + 60_000)))!
      const done = (yield* before.claimNext(at(10), at(Date.now() + 60_000)))!
      yield* before.deadLetter(dead.id, dead.activeAttemptId, at(11), "gave up")
      yield* before.complete(done.id, done.activeAttemptId, at(11))
      const after = yield* open()
      expect(yield* after.release(new Date(), { deadLetters: true })).toBe(2)
      expect(yield* after.get(running.id)).toMatchObject({ status: "pending", attemptCount: 0 })
      expect(yield* after.get(dead.id)).toMatchObject({ status: "pending", attemptCount: 0 })
      expect(yield* after.get(done.id)).toMatchObject({ status: "completed" })
      // A key's running job is gone with its process: the key's jobs are claimable at once.
      expect((yield* after.claimNext(new Date(), at(Date.now() + 60_000)))?.id).toBe("running")
    }),
  )

  it.effect("prunes jobs that completed before a time", () =>
    Effect.gen(function* () {
      const outbox = yield* open()
      yield* outbox.enqueue(job("old", undefined, 1))
      yield* outbox.enqueue(job("new", undefined, 2))
      const old = (yield* outbox.claimNext(at(5), at(100)))!
      const recent = (yield* outbox.claimNext(at(5), at(100)))!
      yield* outbox.complete(old.id, old.activeAttemptId, at(10))
      yield* outbox.complete(recent.id, recent.activeAttemptId, at(30))
      expect(yield* outbox.prune(at(20))).toBe(1)
      expect((yield* outbox.list()).map((item) => item.id)).toEqual(["new"])
    }),
  )
})
