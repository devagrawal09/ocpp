import { describe, expect } from "bun:test"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { SpecterOutbox } from "@ocpp/core/specter/outbox"
import { ReactionOutboxLeaseLostError } from "@specter/agent-runtime"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Effect } from "effect"
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
const open = (reaction = "runStep") =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* SpecterOutbox.make<{ readonly id: string }>(db, reaction)
  })

describe("Specter outbox", () => {
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

  it.effect("runs one job per concurrency key at a time, in order", () =>
    Effect.gen(function* () {
      const outbox = yield* open()
      yield* outbox.enqueue(job("a1", "a", 1))
      yield* outbox.enqueue(job("a2", "a", 2))
      yield* outbox.enqueue(job("b1", "b", 3))
      yield* outbox.enqueue(job("free", undefined, 4))
      const now = at(10)
      const lease = at(1_000)
      const first = yield* outbox.claimNext(now, lease)
      expect(first?.id).toBe("a1")
      expect((yield* outbox.claimNext(now, lease))?.id).toBe("b1")
      expect((yield* outbox.claimNext(now, lease))?.id).toBe("free")
      expect(yield* outbox.claimNext(now, lease)).toBeUndefined()
      // a2 waits for a1, so the next work is the earliest lease.
      expect(yield* outbox.nextWorkAt()).toEqual(lease)
      yield* outbox.complete(first!.id, first!.activeAttemptId, at(20))
      expect(yield* outbox.nextWorkAt()).toEqual(at(2))
      const second = yield* outbox.claimNext(at(20), lease)
      expect(second).toMatchObject({ id: "a2", status: "running", attemptCount: 1, activeAttemptId: "a2:attempt:1" })
    }),
  )

  it.effect("settles only the active attempt", () =>
    Effect.gen(function* () {
      const outbox = yield* open()
      yield* outbox.enqueue(job("j", "s"))
      const claim = (yield* outbox.claimNext(at(0), at(100)))!
      yield* outbox.reschedule(claim.id, claim.activeAttemptId, at(50), "boom")
      expect(yield* outbox.get("j")).toMatchObject({ status: "pending", availableAt: at(50), lastError: "boom" })
      const stale = yield* outbox.complete(claim.id, claim.activeAttemptId, at(60)).pipe(Effect.flip)
      expect(stale).toBeInstanceOf(ReactionOutboxLeaseLostError)
      const retry = (yield* outbox.claimNext(at(50), at(100)))!
      expect(retry.attemptCount).toBe(2)
      yield* outbox.renewLease(retry.id, retry.activeAttemptId, at(500))
      expect(yield* outbox.requeueExpired(at(400))).toBe(0)
      expect(yield* outbox.requeueExpired(at(500))).toBe(1)
      expect(yield* outbox.get("j")).toMatchObject({ status: "pending", lastError: "Reaction attempt lease expired" })
      const last = (yield* outbox.claimNext(at(500), at(600)))!
      yield* outbox.deadLetter(last.id, last.activeAttemptId, at(510), "gave up")
      expect(yield* outbox.list("dead-letter")).toHaveLength(1)
      yield* outbox.retryDeadLetter("j", at(520))
      expect(yield* outbox.get("j")).toMatchObject({ status: "pending", availableAt: at(520) })
    }),
  )

  it.effect("opening the outbox again requeues what the last process left unfinished", () =>
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
      expect(yield* after.get(running.id)).toMatchObject({ status: "pending", attemptCount: 0 })
      expect(yield* after.get(dead.id)).toMatchObject({ status: "pending", attemptCount: 0 })
      expect(yield* after.get(done.id)).toMatchObject({ status: "completed" })
      // A key's running job is gone with its process: the key's jobs are claimable at once.
      expect((yield* after.claimNext(new Date(), at(Date.now() + 60_000)))?.id).toBe("running")
    }),
  )

  it.effect("prunes jobs that completed before a time", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const outbox = yield* open()
      yield* outbox.enqueue(job("old", undefined, 1))
      yield* outbox.enqueue(job("new", undefined, 2))
      const old = (yield* outbox.claimNext(at(5), at(100)))!
      const recent = (yield* outbox.claimNext(at(5), at(100)))!
      yield* outbox.complete(old.id, old.activeAttemptId, at(10))
      yield* outbox.complete(recent.id, recent.activeAttemptId, at(30))
      yield* SpecterOutbox.prune(db, 20)
      expect((yield* outbox.list()).map((item) => item.id)).toEqual(["new"])
    }),
  )
})
