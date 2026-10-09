export * as SpecterOutbox from "./outbox.js"

import { and, asc, eq, inArray, isNotNull, isNull, lte, notInArray, or } from "drizzle-orm"
import { Effect } from "effect"
import {
  ReactionOutboxLeaseLostError,
  type ReactionOutboxClaim,
  type ReactionOutboxJob,
  type ReactionOutboxStatus,
  type ReactionOutboxStore,
} from "@specter/agent-runtime"
import type { Database } from "../database/database.js"
import { SpecterOutboxJobTable } from "./sql.js"

type DatabaseService = Database.Interface["db"]
type Row = typeof SpecterOutboxJobTable.$inferSelect

const table = SpecterOutboxJobTable

const toJob = <T>(row: Row): ReactionOutboxJob<T> => ({
  id: row.id,
  idempotencyKey: row.idempotency_key,
  ...(row.concurrency_key === null ? {} : { concurrencyKey: row.concurrency_key }),
  payload: row.payload as T,
  status: row.status,
  requestedAt: new Date(row.requested_at),
  availableAt: new Date(row.available_at),
  attemptCount: row.attempt_count,
  ...(row.active_attempt_id === null ? {} : { activeAttemptId: row.active_attempt_id }),
  ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: new Date(row.lease_expires_at) }),
  ...(row.completed_at === null ? {} : { completedAt: new Date(row.completed_at) }),
  ...(row.last_error === null ? {} : { lastError: row.last_error }),
})

/**
 * The outbox of one runtime Reaction on OC++'s database. A job is enqueued once per Reaction delivery,
 * so a delivery replayed at boot (its Slice snapshot is older than the job) finds its job instead of
 * running again. Jobs sharing a concurrency key (a Session) run one at a time.
 *
 * Opening the outbox requeues the jobs the last process left unfinished, with a fresh retry budget, as
 * replaying them into an empty outbox did: their attempts died with it, so waiting out their leases
 * only delays the Sessions they run.
 */
export const make = <T>(db: DatabaseService, reaction: string) =>
  Effect.gen(function* () {
    const listeners = new Set<() => void>()
    const notify = () => {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch {
          // A wake-up is a hint; the job is already stored.
        }
      }
    }
    const ofReaction = eq(table.reaction, reaction)
    const transaction = <A, E>(effect: Effect.Effect<A, E>) => db.transaction(() => effect, { behavior: "immediate" })
    const find = (jobId: string) =>
      db
        .select()
        .from(table)
        .where(and(ofReaction, eq(table.id, jobId)))
        .get()
    // Moves an active attempt on, or fails as the worker expects when the attempt is no longer active.
    const settle = (jobId: string, attemptId: string, set: Partial<typeof table.$inferInsert>) =>
      db
        .update(table)
        .set({ ...set, active_attempt_id: null, lease_expires_at: null })
        .where(
          and(ofReaction, eq(table.id, jobId), eq(table.status, "running"), eq(table.active_attempt_id, attemptId)),
        )
        .returning({ id: table.id })
        .get()
        .pipe(Effect.flatMap((row) => (row ? Effect.void : Effect.fail(new ReactionOutboxLeaseLostError(attemptId)))))
    // Keys with a running job: their pending jobs wait for it.
    const busyKeys = db
      .select({ key: table.concurrency_key })
      .from(table)
      .where(and(ofReaction, eq(table.status, "running"), isNotNull(table.concurrency_key)))
      .all()
      .pipe(Effect.map((rows) => rows.flatMap((row) => (row.key === null ? [] : [row.key]))))
    const unblocked = (busy: readonly string[]) =>
      busy.length === 0 ? undefined : or(isNull(table.concurrency_key), notInArray(table.concurrency_key, [...busy]))

    yield* db
      .update(table)
      .set({
        status: "pending",
        available_at: Date.now(),
        attempt_count: 0,
        active_attempt_id: null,
        lease_expires_at: null,
        completed_at: null,
      })
      .where(and(ofReaction, inArray(table.status, ["running", "dead-letter"])))
      .run()

    const store: ReactionOutboxStore<T> & Required<Pick<ReactionOutboxStore<T>, "renewLease" | "subscribe">> = {
      concurrencyKeys: true,
      enqueue: (input) =>
        transaction(
          Effect.gen(function* () {
            const existing = yield* db
              .select()
              .from(table)
              .where(and(ofReaction, eq(table.idempotency_key, input.idempotencyKey)))
              .get()
            if (existing) return { job: toJob<T>(existing), created: false }
            const row = yield* db
              .insert(table)
              .values({
                id: input.id,
                reaction,
                idempotency_key: input.idempotencyKey,
                concurrency_key: input.concurrencyKey ?? null,
                payload: input.payload,
                status: "pending",
                requested_at: input.requestedAt.getTime(),
                available_at: input.availableAt.getTime(),
                attempt_count: 0,
              })
              .returning()
              .get()
            return { job: toJob<T>(row!), created: true }
          }),
        ).pipe(Effect.tap((result) => Effect.sync(() => result.created && notify()))),
      claimNext: (now, leaseExpiresAt) =>
        transaction(
          Effect.gen(function* () {
            const row = yield* db
              .select()
              .from(table)
              .where(
                and(
                  ofReaction,
                  eq(table.status, "pending"),
                  lte(table.available_at, now.getTime()),
                  unblocked(yield* busyKeys),
                ),
              )
              .orderBy(asc(table.available_at), asc(table.requested_at), asc(table.id))
              .limit(1)
              .get()
            if (!row) return undefined
            const attemptCount = row.attempt_count + 1
            const attemptId = `${row.id}:attempt:${attemptCount}`
            yield* db
              .update(table)
              .set({
                status: "running",
                attempt_count: attemptCount,
                active_attempt_id: attemptId,
                lease_expires_at: leaseExpiresAt.getTime(),
                completed_at: null,
              })
              .where(eq(table.id, row.id))
              .run()
            return {
              ...toJob<T>(row),
              status: "running",
              attemptCount,
              activeAttemptId: attemptId,
              leaseExpiresAt,
            } satisfies ReactionOutboxClaim<T>
          }),
        ),
      complete: (jobId, attemptId, completedAt) =>
        settle(jobId, attemptId, { status: "completed", completed_at: completedAt.getTime(), last_error: null }),
      reschedule: (jobId, attemptId, availableAt, error) =>
        settle(jobId, attemptId, { status: "pending", available_at: availableAt.getTime(), last_error: error }),
      deadLetter: (jobId, attemptId, failedAt, error) =>
        settle(jobId, attemptId, { status: "dead-letter", completed_at: failedAt.getTime(), last_error: error }),
      renewLease: (jobId, attemptId, leaseExpiresAt) =>
        db
          .update(table)
          .set({ lease_expires_at: leaseExpiresAt.getTime() })
          .where(
            and(ofReaction, eq(table.id, jobId), eq(table.status, "running"), eq(table.active_attempt_id, attemptId)),
          )
          .returning({ id: table.id })
          .get()
          .pipe(
            Effect.flatMap((row) => (row ? Effect.void : Effect.fail(new ReactionOutboxLeaseLostError(attemptId)))),
          ),
      requeueExpired: (now) =>
        db
          .update(table)
          .set({
            status: "pending",
            available_at: now.getTime(),
            active_attempt_id: null,
            lease_expires_at: null,
            last_error: "Reaction attempt lease expired",
          })
          .where(and(ofReaction, eq(table.status, "running"), lte(table.lease_expires_at, now.getTime())))
          .returning({ id: table.id })
          .all()
          .pipe(Effect.map((rows) => rows.length)),
      nextWorkAt: () =>
        transaction(
          Effect.gen(function* () {
            const busy = yield* busyKeys
            const rows = yield* db
              .select({ status: table.status, available: table.available_at, lease: table.lease_expires_at })
              .from(table)
              .where(
                and(ofReaction, or(and(eq(table.status, "pending"), unblocked(busy)), eq(table.status, "running"))),
              )
              .all()
            // A job waiting for its key becomes work when the running job ends.
            const wakeups = rows.flatMap((row) =>
              row.status === "pending" ? [row.available] : row.lease === null ? [] : [row.lease],
            )
            return wakeups.length === 0 ? undefined : new Date(Math.min(...wakeups))
          }),
        ),
      get: (jobId) => find(jobId).pipe(Effect.map((row) => (row ? toJob<T>(row) : undefined))),
      list: (status?: ReactionOutboxStatus) =>
        db
          .select()
          .from(table)
          .where(and(ofReaction, status === undefined ? undefined : eq(table.status, status)))
          .orderBy(asc(table.requested_at), asc(table.id))
          .all()
          .pipe(Effect.map((rows) => rows.map((row) => toJob<T>(row)))),
      retryDeadLetter: (jobId, availableAt) =>
        db
          .update(table)
          .set({ status: "pending", available_at: availableAt.getTime(), completed_at: null, last_error: null })
          .where(and(ofReaction, eq(table.id, jobId), eq(table.status, "dead-letter")))
          .returning({ id: table.id })
          .get()
          .pipe(
            Effect.flatMap((row) =>
              row ? Effect.sync(notify) : Effect.fail(new Error(`Reaction outbox job is not dead-lettered: ${jobId}`)),
            ),
          ),
      subscribe: (listener) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }
    return store
  })

/**
 * Removes the jobs that completed before `before`. A delivery that old is behind its Reaction's snapshot;
 * if it is replayed anyway, its job runs again and finds its Commands already recorded.
 */
export const prune = (db: DatabaseService, before: number) =>
  db
    .delete(table)
    .where(and(eq(table.status, "completed"), lte(table.completed_at, before)))
    .run()
