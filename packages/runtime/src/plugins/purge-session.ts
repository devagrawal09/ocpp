import { EventLog, type EventLogFailure, type ReactionPlugin } from "@specter-ts/core"
import { Effect } from "effect"

import type { PurgeSessionRequest } from "../features/session/purge-session-reaction/impl.ts"

// The tombstone a purge keeps: every Slice folds a Session's deletion to forget it and keep refusing its ID.
const tombstones = ["session-deleted"]

// A fork's notebook copy is by reference: the Slices fold it from what they hold of the parent then. What they
// hold of a parent's notebook, Code Mode commands and events comes from these of its facts, so a deleted parent
// keeps them, beside its tombstone, while a fork's copy is in the log: a fold of the log still copies the same.
const notebookCopied = "session-codemode-notebook-copied"
const copied = [
  "session-codemode-execution-settled",
  notebookCopied,
  "session-codemode-notebook-reverted",
  "session-codemode-command-defined",
  "session-codemode-command-removed",
  "session-codemode-event-defined",
  "session-codemode-event-removed",
]

const session = (value: string) => ({ name: "session", value })

// A page of a keyed read, then the next, to the end.
const readAll = (log: EventLog["Service"], key: { readonly name: string; readonly value: string }) =>
  Effect.gen(function* () {
    const events = []
    let afterOrder = 0
    while (true) {
      const page = yield* log.readKey(key, { afterOrder, limit: 500 })
      events.push(...page)
      const last = page.at(-1)
      if (last === undefined || page.length < 500) return events
      afterOrder = last.order
    }
  })

// Purges each Session its Reaction requests: every fact that carries its key (its own, and those of the aggregates
// it owns, which name it), but for its tombstone. The Event Log's purge is atomic; the host removes what it indexes
// of the purged facts in the same transaction.
export const purgeSessionPlugin: ReactionPlugin<PurgeSessionRequest, EventLog> = () =>
  Effect.gen(function* () {
    const log = yield* EventLog

    // The forks whose notebook copy reads the Session: those not yet purged.
    const copiedBy = (sessionID: string) =>
      readAll(log, { name: "parent", value: sessionID }).pipe(
        Effect.map((events) => events.filter((event) => event.type === notebookCopied)),
      )

    // The Session a fork copied its notebook from. The copy is in the fork's first commit, and comes first of
    // what a purge keeps of it.
    const copiedFrom = (sessionID: string) =>
      log
        .readKey(session(sessionID), { limit: 3 })
        .pipe(Effect.map((events) => events.find((event) => event.type === notebookCopied)?.keys["parent"]))

    const purge = (sessionID: string): Effect.Effect<void, EventLogFailure> =>
      Effect.gen(function* () {
        const parent = yield* copiedFrom(sessionID)
        const held = (yield* copiedBy(sessionID)).length > 0
        yield* log.purge(session(sessionID), { keep: held ? [...tombstones, ...copied] : tombstones })
        if (held || parent === undefined) return
        // The parent's facts its copy read may be free now. A parent purged already (its creation is gone) is
        // purged again; a live one, or one whose own purge has not run, keeps them until it is purged.
        const [first] = yield* log.readKey(session(parent), { limit: 1 })
        if (first === undefined || first.type === "session-created") return
        yield* purge(parent)
      })

    return (request) => purge(request.payload.sessionID)
  })
