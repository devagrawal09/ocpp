export * as CodeModeHandler from "./handler.js"

import { CodeMode } from "@ocpp/codemode"
import { and, eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database.js"
import type { SessionSchema } from "../session/schema.js"
import { CodeModeCommandTable } from "./command.sql.js"
import { CodeModeEventTable } from "./event.sql.js"
import { CodeModeBindingTable, CodeModeReservationTable } from "./sql.js"

const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const trigger = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

/** Why a command or event name is invalid, or undefined when it is valid. */
export function nameProblem(name: string) {
  if (trigger.test(name)) return undefined
  return `Name ${JSON.stringify(name)} must be 1 to 64 letters, digits, "-", or "_", starting with a letter or digit.`
}

/**
 * Why a notebook name cannot handle invocations, or undefined when it can. With `pending`, a name that
 * an in-flight execution of this Session will save also counts, so one program can declare a function
 * and register it.
 */
export const problem = Effect.fnUntraced(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  handler: string,
  pending: boolean,
) {
  // The name is interpolated into the invocation program, so it must be a plain identifier.
  if (!identifier.test(handler))
    return `Handler ${JSON.stringify(handler)} must be the name of a top-level notebook function.`
  const binding = yield* db
    .select({ value: CodeModeBindingTable.value })
    .from(CodeModeBindingTable)
    .where(and(eq(CodeModeBindingTable.session_id, sessionID), eq(CodeModeBindingTable.name, handler)))
    .get()
    .pipe(Effect.orDie)
  if (binding)
    return CodeMode.isFunctionValue(binding.value) ? undefined : `Notebook value ${handler} is not a function.`
  const reserved = pending
    ? yield* db
        .select({ name: CodeModeReservationTable.name })
        .from(CodeModeReservationTable)
        .where(and(eq(CodeModeReservationTable.session_id, sessionID), eq(CodeModeReservationTable.name, handler)))
        .get()
        .pipe(Effect.orDie)
    : undefined
  if (reserved) return undefined
  return `The notebook has no function named ${handler}. Save it with a top-level function declaration first.`
})

/**
 * Removes the commands and events whose handler is no longer in the notebook, as after a revert or a
 * fork before the handler was saved, so a later function of the same name never silently becomes
 * their handler. A handler that an in-flight execution will still save keeps them.
 */
export const prune = Effect.fnUntraced(function* (db: Database.Interface["db"], sessionID: SessionSchema.ID) {
  const kept = (table: typeof CodeModeCommandTable | typeof CodeModeEventTable) =>
    sql`(exists (select 1 from ${CodeModeBindingTable} where ${CodeModeBindingTable.session_id} = ${table.session_id} and ${CodeModeBindingTable.name} = ${table.handler})
      or exists (select 1 from ${CodeModeReservationTable} where ${CodeModeReservationTable.session_id} = ${table.session_id} and ${CodeModeReservationTable.name} = ${table.handler}))`
  yield* db
    .delete(CodeModeCommandTable)
    .where(and(eq(CodeModeCommandTable.session_id, sessionID), sql`not ${kept(CodeModeCommandTable)}`))
    .run()
    .pipe(Effect.orDie)
  yield* db
    .delete(CodeModeEventTable)
    .where(and(eq(CodeModeEventTable.session_id, sessionID), sql`not ${kept(CodeModeEventTable)}`))
    .run()
    .pipe(Effect.orDie)
})

/**
 * Copies a Session's commands and events into its fork, which has its own notebook copy. Copied events
 * start disabled and without firing history, so a fork never fires an event alongside its parent.
 */
export const fork = Effect.fnUntraced(function* (
  db: Database.Interface["db"],
  input: { readonly from: SessionSchema.ID; readonly to: SessionSchema.ID },
) {
  const commands = yield* db
    .select()
    .from(CodeModeCommandTable)
    .where(eq(CodeModeCommandTable.session_id, input.from))
    .all()
    .pipe(Effect.orDie)
  if (commands.length > 0)
    yield* db
      .insert(CodeModeCommandTable)
      .values(commands.map((command) => ({ ...command, session_id: input.to })))
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  const events = yield* db
    .select()
    .from(CodeModeEventTable)
    .where(eq(CodeModeEventTable.session_id, input.from))
    .all()
    .pipe(Effect.orDie)
  if (events.length > 0)
    yield* db
      .insert(CodeModeEventTable)
      .values(
        events.map((event) => ({
          ...event,
          session_id: input.to,
          enabled: false,
          time_next: null,
          time_fired: null,
          execution_id: null,
          message_id: null,
          error: null,
          run_count: 0,
          skip_count: 0,
          time_skipped: null,
        })),
      )
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  yield* prune(db, input.to)
})
