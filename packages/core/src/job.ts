export * as Job from "./job.js"

import {
  Array,
  Cause,
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  Scope,
  SynchronizedRef,
} from "effect"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { Identifier } from "./id/id.js"
import { SessionFact } from "@ocpp/schema/session-fact"
import { eq } from "drizzle-orm"
import { Bus } from "./bus.js"
import { Database } from "./database/database.js"
import { JobBackgroundTable } from "./job/sql.js"
import { JobProjector } from "./job/projector.js"
import { SessionMessage } from "./session/message.js"
import { SessionSchema } from "./session/schema.js"

const Background = Schema.Struct({
  id: Schema.String,
  notificationID: SessionMessage.ID,
  recovery: SessionFact.BackgroundRecovery,
  status: Schema.Literals(["running", "completed", "error", "cancelled"]),
  terminal: Schema.optionalKey(Schema.Boolean),
  output: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
})

export type Background = typeof Background.Type
export type Recovery = Background["recovery"]
export type Status = Background["status"]

export type Info = {
  id: string
  type: string
  title?: string
  status: Status
  started_at: number
  completed_at?: number
  output?: string
  error?: string
  metadata?: Record<string, unknown>
  notificationID?: SessionMessage.ID
}

type Active = {
  info: Info
  done: Deferred.Deferred<Info>
  backgrounded: Deferred.Deferred<Info>
  scope: Scope.Closeable
  token: object
  blockingSessions: Map<SessionSchema.ID, number>
  isBackgrounded: boolean
  ownerSessionID?: SessionSchema.ID
  recovery?: Recovery
}

type State = {
  jobs: SynchronizedRef.SynchronizedRef<Map<string, Active>>
  scope: Scope.Scope
}

type FinishResult = {
  info?: Info
  done?: Deferred.Deferred<Info>
  scope?: Scope.Closeable
}

type BackgroundResult = {
  info?: Info
  backgrounded?: Deferred.Deferred<Info>
}

type StartResult = { info: Info | undefined } | { info: Info; scope: Scope.Closeable; token: object }

type BlockWait = {
  done: Deferred.Deferred<Info>
  backgrounded: Deferred.Deferred<Info>
}

type BlockStart =
  | { type: "missing" }
  | { type: "finished"; info: Info }
  | { type: "backgrounded"; info: Info }
  | { type: "wait"; wait: BlockWait }

export type StartInput = {
  id?: string
  type: string
  title?: string
  metadata?: Record<string, unknown>
  recovery?: Recovery
  notificationID?: SessionMessage.ID
  run: Effect.Effect<string, unknown>
}

export type StartLimitedInput = StartInput & {
  ownerSessionID: SessionSchema.ID
  maxConcurrent: number
}

export type WaitInput = {
  id: string
  timeout?: number
}

export type WaitResult = {
  info?: Info
  timedOut: boolean
}

export type BlockInput = {
  id: string
  sessionID: SessionSchema.ID
}

export type BlockResult = { type: "finished"; info: Info } | { type: "backgrounded"; info: Info }

export type BackgroundAllInput = {
  sessionID: SessionSchema.ID
  type?: string
}

export type CancelAllInput = {
  ownerSessionID: SessionSchema.ID
  type?: string
  discardBackground?: boolean
}

export type ActiveInput = {
  ownerSessionID: SessionSchema.ID
  type?: string
}

export interface Interface {
  readonly get: (id: string) => Effect.Effect<Info | undefined>
  readonly start: (input: StartInput) => Effect.Effect<Info>
  readonly startLimited: (input: StartLimitedInput) => Effect.Effect<Info | undefined>
  /** Running work owned by a Session, in start order; the population `startLimited` counts against. */
  readonly active: (input: ActiveInput) => Effect.Effect<readonly Info[]>
  readonly wait: (input: WaitInput) => Effect.Effect<WaitResult>
  readonly block: (input: BlockInput) => Effect.Effect<BlockResult | undefined>
  readonly background: (id: string) => Effect.Effect<Info | undefined>
  readonly backgroundAll: (input: BackgroundAllInput) => Effect.Effect<Info[]>
  readonly cancel: (id: string) => Effect.Effect<Info | undefined>
  readonly cancelAll: (input: CancelAllInput) => Effect.Effect<Info[]>
  readonly pendingBackground: Effect.Effect<readonly Background[]>
  readonly markBackgroundTerminal: (notificationID: SessionMessage.ID) => Effect.Effect<void>
  readonly completeBackground: (notificationID: SessionMessage.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/Job") {}

function snapshot(job: Active): Info {
  return {
    ...job.info,
    ...(job.info.metadata ? { metadata: { ...job.info.metadata } } : {}),
  }
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** A finished job's settlement of its marker; none while it runs. */
function settlement(notificationID: SessionMessage.ID, info: Info) {
  if (info.status === "running") return
  return [
    SessionFact.BackgroundSettled,
    {
      notificationID,
      outcome: info.status,
      ...(info.output !== undefined ? { output: info.output } : {}),
      ...(info.error !== undefined ? { error: info.error } : {}),
    },
  ] as const
}

function incrementSession(input: Map<SessionSchema.ID, number>, sessionID: SessionSchema.ID) {
  return new Map(input).set(sessionID, (input.get(sessionID) ?? 0) + 1)
}

function decrementSession(input: Map<SessionSchema.ID, number>, sessionID: SessionSchema.ID) {
  const count = input.get(sessionID)
  if (count === undefined) return input
  const next = new Map(input)
  if (count <= 1) next.delete(sessionID)
  else next.set(sessionID, count - 1)
  return next
}

/**
 * Makes one scoped, process-local registry. Explicitly recoverable background
 * work also owns a durable notification marker until its notification is admitted.
 */
export const make = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  const state: State = {
    jobs: yield* SynchronizedRef.make(new Map()),
    scope: yield* Scope.Scope,
  }

  // A recoverable job's marker is the projection of its facts in Specter's Event Log (JobProjector):
  // going to the background starts it, and the job's outcome settles it. A job that ends before its
  // start was recorded records both at once.
  const recordBackground = Effect.fnUntraced(function* (job: Active, recorded: boolean) {
    if (!job.recovery || !job.info.notificationID) return
    const settled = settlement(job.info.notificationID, job.info)
    if (recorded) {
      if (settled) yield* bus.publish(...settled)
      return
    }
    const started = [
      SessionFact.BackgroundStarted,
      { notificationID: job.info.notificationID, jobID: job.info.id, recovery: job.recovery },
    ] as const
    if (!settled) {
      yield* bus.publish(...started)
      return
    }
    yield* bus.publishAll([started, settled])
  })
  const findBackground = (notificationID: SessionMessage.ID) =>
    db
      .select()
      .from(JobBackgroundTable)
      .where(eq(JobBackgroundTable.notification_id, notificationID))
      .get()
      .pipe(Effect.orDie)
  const completeBackground: Interface["completeBackground"] = Effect.fn("Job.completeBackground")(
    function* (notificationID) {
      if (!(yield* findBackground(notificationID))) return
      yield* bus.publish(SessionFact.BackgroundCompleted, { notificationID })
    },
  )

  const settle = Effect.fnUntraced(function* (id: string, token: object, exit: Exit.Exit<string, unknown>) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [FinishResult, Map<string, Active>]> {
        const job = jobs.get(id)
        if (!job) return [{}, jobs]
        if (job.token !== token) return [{}, jobs]
        if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
        const status: Exclude<Status, "running"> = Exit.isSuccess(exit)
          ? "completed"
          : Cause.hasInterruptsOnly(exit.cause)
            ? "cancelled"
            : "error"
        const next = {
          ...job,
          blockingSessions: new Map<SessionSchema.ID, number>(),
          info: {
            ...job.info,
            status,
            completed_at,
            ...(Exit.isSuccess(exit) ? { output: exit.value } : {}),
            ...(Exit.isFailure(exit) ? { error: errorText(Cause.squash(exit.cause)) } : {}),
          },
        }
        if (status !== "cancelled") yield* recordBackground(next, job.isBackgrounded)
        return [{ info: snapshot(next), done: job.done, scope: job.scope }, new Map(jobs).set(id, next)]
      }),
    )
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info)
    if (result.scope) {
      yield* Scope.close(result.scope, Exit.void).pipe(Effect.forkIn(state.scope, { startImmediately: true }))
    }
    return result.info
  })

  const get: Interface["get"] = Effect.fn("Job.get")(function* (id) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(id)
    if (!job) return undefined
    return snapshot(job)
  })

  const startJob = Effect.fnUntraced(function* (input: StartInput, limited?: StartLimitedInput) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const id = input.id ?? Identifier.ascending("job")
        const started_at = yield* Clock.currentTimeMillis
        const done = yield* Deferred.make<Info>()
        const backgrounded = yield* Deferred.make<Info>()
        const result = yield* SynchronizedRef.modifyEffect(
          state.jobs,
          Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [StartResult, Map<string, Active>]> {
            const existing = jobs.get(id)
            if (existing?.info.status === "running") return [{ info: snapshot(existing) }, jobs]
            if (
              limited &&
              [...jobs.values()].filter(
                (job) =>
                  job.info.status === "running" &&
                  job.info.type === input.type &&
                  job.ownerSessionID === limited.ownerSessionID,
              ).length >= limited.maxConcurrent
            )
              return [{ info: undefined }, jobs]
            const scope = yield* Scope.fork(state.scope, "parallel")
            const token = {}
            const job = {
              info: {
                id,
                type: input.type,
                title: input.title,
                status: "running" as const,
                started_at,
                metadata: input.metadata,
                ...(input.notificationID ? { notificationID: input.notificationID } : {}),
              },
              done,
              backgrounded,
              scope,
              token,
              blockingSessions: new Map<SessionSchema.ID, number>(),
              isBackgrounded: false,
              ownerSessionID: limited?.ownerSessionID,
              recovery: input.recovery,
            }
            return [{ info: snapshot(job), scope, token }, new Map(jobs).set(id, job)]
          }),
        )
        if (!result.info) return undefined
        if ("scope" in result)
          yield* restore(input.run).pipe(
            Effect.exit,
            Effect.flatMap((exit) => settle(id, result.token, exit)),
            Effect.asVoid,
            Effect.forkIn(result.scope, { startImmediately: true }),
          )
        return result.info
      }),
    )
  })

  const start: Interface["start"] = Effect.fn("Job.start")((input) =>
    startJob(input).pipe(
      Effect.flatMap((info) => (info ? Effect.succeed(info) : Effect.die(new Error("Unbounded job admission failed")))),
    ),
  )

  const startLimited: Interface["startLimited"] = Effect.fn("Job.startLimited")((input) => startJob(input, input))

  const active: Interface["active"] = Effect.fn("Job.active")(function* (input) {
    return [...(yield* SynchronizedRef.get(state.jobs)).values()]
      .filter(
        (job) =>
          job.info.status === "running" &&
          job.ownerSessionID === input.ownerSessionID &&
          (input.type === undefined || job.info.type === input.type),
      )
      .toSorted((left, right) => left.info.started_at - right.info.started_at)
      .map(snapshot)
  })

  const wait: Interface["wait"] = Effect.fn("Job.wait")(function* (input) {
    const job = (yield* SynchronizedRef.get(state.jobs)).get(input.id)
    if (!job) return { timedOut: false }
    if (job.info.status !== "running") return { info: snapshot(job), timedOut: false }
    if (input.timeout === undefined) return { info: yield* Deferred.await(job.done), timedOut: false }
    if (input.timeout <= 0) return { info: snapshot(job), timedOut: true }
    const info = yield* Deferred.await(job.done).pipe(Effect.timeoutOption(input.timeout))
    if (info._tag === "Some") return { info: info.value, timedOut: false }
    return { info: snapshot(job), timedOut: true }
  })

  const removeBlock = Effect.fnUntraced(function* (input: BlockInput) {
    yield* SynchronizedRef.update(state.jobs, (jobs) => {
      const job = jobs.get(input.id)
      if (!job || job.info.status !== "running" || job.isBackgrounded) return jobs
      return new Map(jobs).set(input.id, {
        ...job,
        blockingSessions: decrementSession(job.blockingSessions, input.sessionID),
      })
    })
  })

  const block: Interface["block"] = Effect.fnUntraced(function* (input) {
    const result = yield* SynchronizedRef.modify(state.jobs, (jobs): readonly [BlockStart, Map<string, Active>] => {
      const job = jobs.get(input.id)
      if (!job) return [{ type: "missing" }, jobs]
      if (job.info.status !== "running") return [{ type: "finished", info: snapshot(job) }, jobs]
      if (job.isBackgrounded) return [{ type: "backgrounded", info: snapshot(job) }, jobs]
      return [
        { type: "wait", wait: { done: job.done, backgrounded: job.backgrounded } },
        new Map(jobs).set(input.id, {
          ...job,
          blockingSessions: incrementSession(job.blockingSessions, input.sessionID),
        }),
      ]
    })
    if (result.type === "missing") return undefined
    if (result.type === "finished") return { type: "finished", info: result.info }
    if (result.type === "backgrounded") return { type: "backgrounded", info: result.info }
    return yield* Effect.raceFirst(
      Deferred.await(result.wait.done).pipe(Effect.map((info) => ({ type: "finished" as const, info }))),
      Deferred.await(result.wait.backgrounded).pipe(Effect.map((info) => ({ type: "backgrounded" as const, info }))),
    ).pipe(Effect.ensuring(removeBlock(input)))
  })

  const markBackground = Effect.fnUntraced(function* (job: Active) {
    const next = {
      ...job,
      isBackgrounded: true,
      blockingSessions: new Map<SessionSchema.ID, number>(),
      info: {
        ...job.info,
        ...(job.recovery ? { notificationID: job.info.notificationID ?? SessionMessage.ID.create() } : {}),
      },
    }
    yield* recordBackground(next, false)
    return next
  })

  const background: Interface["background"] = Effect.fn("Job.background")(function* (id) {
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [BackgroundResult, Map<string, Active>]> {
        const job = jobs.get(id)
        // Recoverable work may finish before the caller backgrounds it.
        if (!job || (job.info.status !== "running" && !job.recovery)) return [{}, jobs]
        if (job.isBackgrounded) return [{ info: snapshot(job) }, jobs]
        const next = yield* markBackground(job)
        return [{ info: snapshot(next), backgrounded: job.backgrounded }, new Map(jobs).set(id, next)]
      }),
    )
    if (result.info && result.backgrounded) yield* Deferred.succeed(result.backgrounded, result.info)
    return result.info
  })

  const backgroundAll: Interface["backgroundAll"] = Effect.fn("Job.backgroundAll")(function* (input) {
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<
        readonly [Required<BackgroundResult>[], Map<string, Active>]
      > {
        const results: Required<BackgroundResult>[] = []
        const next = new Map(jobs)
        for (const [id, job] of jobs) {
          if (job.info.status !== "running") continue
          if (job.isBackgrounded) continue
          if (input.type !== undefined && job.info.type !== input.type) continue
          if (!job.blockingSessions.has(input.sessionID)) continue
          const updated = yield* markBackground(job)
          results.push({ info: snapshot(updated), backgrounded: job.backgrounded })
          next.set(id, updated)
        }
        return [results, next]
      }),
    )
    yield* Effect.forEach(result, (item) => Deferred.succeed(item.backgrounded, item.info), { discard: true })
    return result.map((item) => item.info)
  })

  const cancel: Interface["cancel"] = Effect.fn("Job.cancel")(function* (id) {
    const completed_at = yield* Clock.currentTimeMillis
    const result = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [FinishResult, Map<string, Active>]> {
        const job = jobs.get(id)
        if (!job) return [{}, jobs]
        if (job.info.status !== "running") return [{ info: snapshot(job) }, jobs]
        const next = {
          ...job,
          blockingSessions: new Map<SessionSchema.ID, number>(),
          info: {
            ...job.info,
            status: "cancelled" as const,
            completed_at,
          },
        }
        yield* recordBackground(next, job.isBackgrounded)
        return [{ info: snapshot(next), done: job.done, scope: job.scope }, new Map(jobs).set(id, next)]
      }),
    )
    if (result.info && result.done) yield* Deferred.succeed(result.done, result.info)
    if (result.scope) yield* Scope.close(result.scope, Exit.void)
    return result.info
  })

  const cancelAll: Interface["cancelAll"] = Effect.fn("Job.cancelAll")(function* (input) {
    const completed_at = yield* Clock.currentTimeMillis
    const results = yield* SynchronizedRef.modifyEffect(
      state.jobs,
      Effect.fnUntraced(function* (jobs): Effect.fn.Return<readonly [FinishResult[], Map<string, Active>]> {
        const finished: FinishResult[] = []
        const next = new Map(jobs)
        for (const [id, job] of jobs) {
          if (job.ownerSessionID !== input.ownerSessionID) continue
          if (input.type !== undefined && job.info.type !== input.type) continue
          if (job.info.status !== "running") {
            if (input.discardBackground && job.info.notificationID) finished.push({ info: snapshot(job) })
            continue
          }
          const updated = {
            ...job,
            blockingSessions: new Map<SessionSchema.ID, number>(),
            info: { ...job.info, status: "cancelled" as const, completed_at },
          }
          yield* recordBackground(updated, job.isBackgrounded)
          finished.push({ info: snapshot(updated), done: job.done, scope: job.scope })
          next.set(id, updated)
        }
        return [finished, next]
      }),
    )
    if (input.discardBackground)
      yield* Effect.forEach(
        results,
        (result) => (result.info?.notificationID ? completeBackground(result.info.notificationID) : Effect.void),
        { discard: true },
      )
    yield* Effect.forEach(
      results,
      (result) =>
        Effect.gen(function* () {
          if (result.info && result.done) yield* Deferred.succeed(result.done, result.info)
          if (result.scope) yield* Scope.close(result.scope, Exit.void)
        }),
      { discard: true },
    )
    return results.flatMap((result) => (result.info ? [result.info] : []))
  })

  const pendingBackground: Interface["pendingBackground"] = db
    .select()
    .from(JobBackgroundTable)
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) =>
        rows.map(
          (row): Background => ({
            id: row.job_id,
            notificationID: row.notification_id,
            recovery: row.recovery,
            status: row.status,
            ...(row.terminal ? { terminal: true } : {}),
            ...(row.output === null ? {} : { output: row.output }),
            ...(row.error === null ? {} : { error: row.error }),
          }),
        ),
      ),
      Effect.withSpan("Job.pendingBackground"),
    )

  const markBackgroundTerminal: Interface["markBackgroundTerminal"] = Effect.fn("Job.markBackgroundTerminal")(
    function* (notificationID) {
      const background = yield* findBackground(notificationID)
      if (!background) {
        yield* Effect.die(new Error(`Background notification ${notificationID} is unavailable`))
        return
      }
      if (background.terminal) return
      yield* bus.publish(SessionFact.BackgroundTerminal, { notificationID })
    },
  )

  return Service.of({
    get,
    start,
    startLimited,
    active,
    wait,
    block,
    background,
    backgroundAll,
    cancel,
    cancelAll,
    pendingBackground,
    markBackgroundTerminal,
    completeBackground,
  })
})

const layer = Layer.effect(Service, make)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node, JobProjector.node] })
