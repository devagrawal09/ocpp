import { appendFileSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import {
  ReactionOutboxLeaseLostError,
  type ReactionOutboxJob,
  type ReactionOutboxStore,
} from "@specter-ts/reaction-outbox"
import { Effect } from "effect"

type StoredJob<TPayload> = Omit<
  ReactionOutboxJob<TPayload>,
  "requestedAt" | "availableAt" | "leaseExpiresAt" | "completedAt"
> & {
  requestedAt: string
  availableAt: string
  leaseExpiresAt?: string
  completedAt?: string
}

/**
 * Spike-only durable outbox: every job transition appends the whole job as one JSONL line and
 * the last line per job wins on open. Like the JSONL Event Log, the process that opens the file
 * must be its only writer, so jobs left `running` by a dead owner are requeued on open instead
 * of waiting out their lease (the outbox has no lease renewal, so leases must outlast a turn).
 */
export async function openFileReactionOutboxStore<TPayload>(path: string): Promise<ReactionOutboxStore<TPayload>> {
  mkdirSync(dirname(path), { recursive: true })
  const file = Bun.file(path)
  const text = (await file.exists()) ? await file.text() : ""
  const jobs = new Map<string, ReactionOutboxJob<TPayload>>()
  const now = new Date()
  text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => decode(JSON.parse(line) as StoredJob<TPayload>))
    .forEach((job) => jobs.set(job.id, job))
  const recovered = [...jobs.values()].filter((job) => job.status === "running")
  recovered.forEach((job) =>
    write({
      ...job,
      status: "pending",
      availableAt: now,
      activeAttemptId: undefined,
      leaseExpiresAt: undefined,
      lastError: "Previous owner exited during the attempt",
    }),
  )

  function write(job: ReactionOutboxJob<TPayload>) {
    jobs.set(job.id, job)
    appendFileSync(path, JSON.stringify(job) + "\n")
  }

  function active(jobId: string, attemptId: string) {
    const job = jobs.get(jobId)
    if (!job) throw new Error(`Unknown Reaction outbox job: ${jobId}`)
    if (job.status !== "running" || job.activeAttemptId !== attemptId) throw new ReactionOutboxLeaseLostError(attemptId)
    return job
  }

  const settle = (job: ReactionOutboxJob<TPayload>) => ({
    ...job,
    activeAttemptId: undefined,
    leaseExpiresAt: undefined,
  })

  return {
    enqueue: (input) =>
      Effect.sync(() => {
        const existing = [...jobs.values()].find((job) => job.idempotencyKey === input.idempotencyKey)
        if (existing) return { job: existing, created: false }
        const job: ReactionOutboxJob<TPayload> = { ...input, status: "pending", attemptCount: 0 }
        write(job)
        return { job, created: true }
      }),
    claimNext: (at, leaseExpiresAt) =>
      Effect.sync(() => {
        const job = [...jobs.values()]
          .filter((candidate) => candidate.status === "pending" && candidate.availableAt <= at)
          .sort((left, right) => left.availableAt.getTime() - right.availableAt.getTime())[0]
        if (!job) return undefined
        const attemptCount = job.attemptCount + 1
        const claim = {
          ...job,
          status: "running" as const,
          attemptCount,
          activeAttemptId: `${job.id}:attempt:${attemptCount}`,
          leaseExpiresAt,
        }
        write(claim)
        return claim
      }),
    complete: (jobId, attemptId, completedAt) =>
      Effect.sync(() => {
        write({ ...settle(active(jobId, attemptId)), status: "completed", completedAt, lastError: undefined })
      }),
    reschedule: (jobId, attemptId, availableAt, error) =>
      Effect.sync(() => {
        write({ ...settle(active(jobId, attemptId)), status: "pending", availableAt, lastError: error })
      }),
    deadLetter: (jobId, attemptId, failedAt, error) =>
      Effect.sync(() => {
        write({ ...settle(active(jobId, attemptId)), status: "dead-letter", completedAt: failedAt, lastError: error })
      }),
    requeueExpired: (at) =>
      Effect.sync(() => {
        const expired = [...jobs.values()].filter(
          (job) => job.status === "running" && job.leaseExpiresAt !== undefined && job.leaseExpiresAt <= at,
        )
        expired.forEach((job) =>
          write({ ...settle(job), status: "pending", availableAt: at, lastError: "Reaction attempt lease expired" }),
        )
        return expired.length
      }),
    nextWorkAt: () =>
      Effect.sync(() => {
        const wakeups = [...jobs.values()].flatMap((job) => {
          if (job.status === "pending") return [job.availableAt]
          if (job.status === "running" && job.leaseExpiresAt) return [job.leaseExpiresAt]
          return []
        })
        return wakeups.sort((left, right) => left.getTime() - right.getTime())[0]
      }),
    get: (jobId) => Effect.sync(() => jobs.get(jobId)),
    list: (status) => Effect.sync(() => [...jobs.values()].filter((job) => !status || job.status === status)),
    retryDeadLetter: (jobId, availableAt) =>
      Effect.sync(() => {
        const job = jobs.get(jobId)
        if (job?.status !== "dead-letter") throw new Error(`Reaction outbox job is not dead-lettered: ${jobId}`)
        write({ ...job, status: "pending", availableAt, completedAt: undefined, lastError: undefined })
      }),
  }
}

function decode<TPayload>(stored: StoredJob<TPayload>): ReactionOutboxJob<TPayload> {
  return {
    ...stored,
    requestedAt: new Date(stored.requestedAt),
    availableAt: new Date(stored.availableAt),
    leaseExpiresAt: stored.leaseExpiresAt ? new Date(stored.leaseExpiresAt) : undefined,
    completedAt: stored.completedAt ? new Date(stored.completedAt) : undefined,
  }
}
