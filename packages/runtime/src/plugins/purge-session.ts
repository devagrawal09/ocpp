import { EventLog, type ReactionPlugin } from "@specter-ts/core"
import { Effect } from "effect"

import type { PurgeSessionRequest } from "../features/session/purge-session-reaction/impl.ts"

// The tombstone a purge keeps: every Slice folds a Session's deletion to forget it and keep refusing its ID.
const tombstones = ["session-deleted"]

// Purges each Session its Reaction requests: every fact that carries its key (its own, and those of the aggregates
// it owns, which name it), but for its tombstone. Nothing else reads them: a fork's facts carry what it inherited.
// The Event Log's purge is atomic; the host removes what it indexes of the purged facts in the same transaction.
export const purgeSessionPlugin: ReactionPlugin<PurgeSessionRequest, EventLog> = () =>
  Effect.gen(function* () {
    const log = yield* EventLog
    return (request) =>
      log.purge({ name: "session", value: request.payload.sessionID }, { keep: tombstones }).pipe(Effect.asVoid)
  })
