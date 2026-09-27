export * as CodeModeHandler from "./handler.js"

import { CodeMode } from "@ocpp/codemode"
import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database.js"
import type { SessionSchema } from "../session/schema.js"
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
