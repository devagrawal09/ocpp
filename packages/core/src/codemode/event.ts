export * as CodeModeEvent from "./event.js"

import { CodeModeEvent } from "@ocpp/schema/codemode-event"
import type { CodeModeExecution } from "@ocpp/schema/codemode-execution"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { and, asc, eq, sql } from "drizzle-orm"
import type { SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core"
import { Clock, Context, Cron, Effect, Layer, PubSub, Result, Schema, Scope } from "effect"
import { Database } from "../database/database.js"
import type { SessionMessage } from "../session/message.js"
import type { SessionSchema } from "../session/schema.js"
import { SessionStore } from "../session/store.js"
import { CodeModeEventTable } from "./event.sql.js"
import { CodeModeHandler } from "./handler.js"

export const Info = CodeModeEvent.Info
export type Info = CodeModeEvent.Info
export const Schedule = CodeModeEvent.Schedule
export type Schedule = CodeModeEvent.Schedule

export class DefinitionError extends Schema.TaggedError<DefinitionError>()("CodeModeEvent.DefinitionError", {
  message: Schema.String,
}) {}

export type Definition = typeof CodeModeEventTable.$inferSelect

export type Key = { readonly sessionID: SessionSchema.ID; readonly name: string }

export interface Interface {
  /**
   * Defines or replaces an event. A replaced event starts over as if it had not fired, except that a
   * firing still running keeps the new definition from overlapping it.
   */
  readonly define: (
    sessionID: SessionSchema.ID,
    input: {
      readonly name: string
      readonly description: string
      readonly schedule: Schedule
      readonly handler: string
      readonly input?: Schema.Json
    },
  ) => Effect.Effect<Info, DefinitionError>
  readonly list: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Info>>
  readonly get: (key: Key) => Effect.Effect<Definition | undefined>
  readonly setEnabled: (key: Key, enabled: boolean) => Effect.Effect<Info | undefined>
  readonly remove: (key: Key) => Effect.Effect<boolean>
  /** Every enabled event across Sessions, for the scheduler. */
  readonly enabled: () => Effect.Effect<ReadonlyArray<Definition>>
  /** Records when the scheduler will fire the event next, or that it will not. */
  readonly scheduled: (key: Key, next: number | undefined) => Effect.Effect<void>
  /** Records a firing: its execution when it started, or why it could not. */
  readonly fired: (
    key: Key,
    firing: { readonly at: number } & (
      | { readonly executionID: string; readonly messageID: SessionMessage.ID }
      | { readonly error: string }
    ),
  ) => Effect.Effect<void>
  readonly skipped: (key: Key, at: number) => Effect.Effect<void>
  /** Announces definition changes the scheduler must apply. Subscribe before reading definitions. */
  readonly changes: Effect.Effect<PubSub.Subscription<Key>, never, Scope.Scope>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/CodeModeEvent") {}

const MIN_INTERVAL = 1000
const SUMMARY_LENGTH = 200

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessions = yield* SessionStore.Service
    const pubsub = yield* PubSub.unbounded<Key>()
    const where = (key: Key) =>
      and(eq(CodeModeEventTable.session_id, key.sessionID), eq(CodeModeEventTable.name, key.name))
    const get = (key: Key) => db.select().from(CodeModeEventTable).where(where(key)).get().pipe(Effect.orDie)
    const update = (key: Key, set: SQLiteUpdateSetSource<typeof CodeModeEventTable>) =>
      db.update(CodeModeEventTable).set(set).where(where(key)).run().pipe(Effect.orDie, Effect.asVoid)

    // The latest run's outcome is read from its invocation message, which restart recovery also settles.
    const info = Effect.fnUntraced(function* (row: Definition) {
      const invocation = row.message_id ? (yield* sessions.message(row.message_id))?.message : undefined
      const run = invocation?.type === "invocation" ? invocation : undefined
      const returned = run?.events?.findLast(
        (event): event is Extract<CodeModeExecution.Entry, { kind: "return" }> =>
          event.type === "trace" && event.kind === "return",
      )
      const summary = row.error ?? run?.error ?? returned?.value
      return Info.make({
        name: row.name,
        description: row.description,
        schedule: row.schedule,
        handler: row.handler,
        ...(row.input === null ? {} : { input: row.input }),
        enabled: row.enabled,
        ...(row.time_next === null ? {} : { nextFireAt: new Date(row.time_next).toISOString() }),
        ...(row.time_fired === null ? {} : { lastFiredAt: new Date(row.time_fired).toISOString() }),
        ...(row.error !== null ? { lastStatus: "error" as const } : run ? { lastStatus: run.status } : {}),
        ...(summary === undefined ? {} : { lastSummary: summary.slice(0, SUMMARY_LENGTH) }),
        runCount: row.run_count,
        skipCount: row.skip_count,
        ...(row.time_skipped === null ? {} : { lastSkippedAt: new Date(row.time_skipped).toISOString() }),
      })
    })

    return Service.of({
      define: Effect.fn("CodeModeEvent.define")(function* (sessionID, input) {
        // A subagent's Session ends with its task, so nothing would ever see its events' outcomes.
        const session = yield* sessions.get(sessionID)
        const problem =
          (session?.parentID
            ? "Events cannot be defined in a subagent Session, which ends with its task. Define the event in the top-level Session instead."
            : undefined) ??
          CodeModeHandler.nameProblem(input.name) ??
          scheduleProblem(input.schedule) ??
          (yield* CodeModeHandler.problem(db, sessionID, input.handler, true))
        if (problem) return yield* new DefinitionError({ message: problem })
        const now = yield* Clock.currentTimeMillis
        const key = { sessionID, name: input.name }
        const row = yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              // A replaced event keeps its running firing, so its new handler cannot overlap the old one.
              const replaced = yield* tx
                .delete(CodeModeEventTable)
                .where(where(key))
                .returning({ execution_id: CodeModeEventTable.execution_id })
                .get()
              return yield* tx
                .insert(CodeModeEventTable)
                .values({
                  session_id: sessionID,
                  name: input.name,
                  description: input.description,
                  schedule: input.schedule,
                  handler: input.handler,
                  input: input.input ?? null,
                  enabled: true,
                  execution_id: replaced?.execution_id ?? null,
                  time_next: next(input.schedule, { now, anchor: now }) ?? null,
                  time_created: now,
                  time_updated: now,
                })
                .returning()
                .get()
            }),
          )
          .pipe(Effect.orDie)
        yield* PubSub.publish(pubsub, key)
        return yield* info(row)
      }),
      list: Effect.fn("CodeModeEvent.list")(function* (sessionID) {
        const rows = yield* db
          .select()
          .from(CodeModeEventTable)
          .where(eq(CodeModeEventTable.session_id, sessionID))
          .orderBy(asc(CodeModeEventTable.name))
          .all()
          .pipe(Effect.orDie)
        return yield* Effect.forEach(rows, info)
      }),
      get,
      setEnabled: Effect.fn("CodeModeEvent.setEnabled")(function* (key, enabled) {
        const row = yield* get(key)
        if (!row) return undefined
        // A disabled event has no next firing; the scheduler records one again when it is enabled.
        yield* update(key, { enabled, ...(enabled ? {} : { time_next: null }) })
        yield* PubSub.publish(pubsub, key)
        return yield* info({ ...row, enabled, time_next: enabled ? row.time_next : null })
      }),
      remove: Effect.fn("CodeModeEvent.remove")(function* (key) {
        const removed = yield* db
          .delete(CodeModeEventTable)
          .where(where(key))
          .returning({ name: CodeModeEventTable.name })
          .get()
          .pipe(Effect.orDie)
        yield* PubSub.publish(pubsub, key)
        return removed !== undefined
      }),
      enabled: Effect.fn("CodeModeEvent.enabled")(() =>
        db.select().from(CodeModeEventTable).where(eq(CodeModeEventTable.enabled, true)).all().pipe(Effect.orDie),
      ),
      scheduled: Effect.fn("CodeModeEvent.scheduled")((key, time) => update(key, { time_next: time ?? null })),
      fired: Effect.fn("CodeModeEvent.fired")((key, firing) =>
        update(key, {
          time_fired: firing.at,
          run_count: sql`${CodeModeEventTable.run_count} + 1`,
          ...("error" in firing
            ? { execution_id: null, message_id: null, error: firing.error }
            : { execution_id: firing.executionID, message_id: firing.messageID, error: null }),
        }),
      ),
      skipped: Effect.fn("CodeModeEvent.skipped")((key, at) =>
        update(key, {
          time_skipped: at,
          skip_count: sql`${CodeModeEventTable.skip_count} + 1`,
        }),
      ),
      changes: PubSub.subscribe(pubsub),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, SessionStore.node] })

/** Why a schedule is invalid, or undefined when it is valid. */
export function scheduleProblem(schedule: Schedule) {
  if ("every" in schedule) {
    const step = interval(schedule.every)
    if (step === undefined)
      return `Interval ${JSON.stringify(schedule.every)} must be a number and a unit: ms, s, m, h, or d, such as "30s" or "5m".`
    if (step < MIN_INTERVAL) return "An event may fire at most once per second."
    return undefined
  }
  if ("cron" in schedule) {
    const parsed = Cron.parse(schedule.cron, zone())
    return Result.isFailure(parsed)
      ? `Invalid cron expression ${JSON.stringify(schedule.cron)}: ${parsed.failure.message}`
      : undefined
  }
  if (Number.isNaN(Date.parse(schedule.at)))
    return `Time ${JSON.stringify(schedule.at)} must be an ISO 8601 date and time.`
  return undefined
}

/**
 * The next fire time after `now`, or undefined when the schedule has nothing left. An interval keeps
 * the grid its anchor starts, so latency never shifts later firings, and firings missed while the host
 * was down are skipped rather than caught up. A cron expression follows the host's time zone, so its
 * firings keep their wall-clock time across daylight saving changes. A time in the past fires once,
 * as soon as possible. The latest firing bounds the result too, so a schedule never fires twice for
 * one slot.
 */
export function next(
  schedule: Schedule,
  input: { readonly now: number; readonly anchor: number; readonly fired?: number },
) {
  const after = Math.max(input.now, input.fired ?? input.now)
  if ("every" in schedule) {
    const step = interval(schedule.every)
    if (step === undefined) return undefined
    return input.anchor + Math.max(1, Math.floor((after - input.anchor) / step) + 1) * step
  }
  if ("cron" in schedule) {
    const parsed = Cron.parse(schedule.cron, zone())
    return Result.isFailure(parsed) ? undefined : Cron.next(parsed.success, new Date(after)).getTime()
  }
  if (input.fired !== undefined) return undefined
  return Math.max(Date.parse(schedule.at), input.now)
}

/** The host's named time zone, such as "Europe/Berlin", which cron expressions follow. */
export const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone

const units = new Map([
  ["ms", 1],
  ["s", 1000],
  ["m", 60_000],
  ["h", 3_600_000],
  ["d", 86_400_000],
])

function interval(every: string) {
  const match = /^(\d+)\s*(ms|s|m|h|d)$/.exec(every.trim())
  const unit = match ? units.get(match[2]) : undefined
  if (!match || unit === undefined) return undefined
  return Number(match[1]) * unit
}
