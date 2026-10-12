import { SessionFact } from "@ocpp/schema/session-fact"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import { sessionDeleted } from "../../session/lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: the Sessions deleted, their tombstones. A marker
// starts unless its Session was deleted: a new job takes a fresh notification,
// and a resumed one starts again under its own, settled or not.
export type BackgroundJobState = { sessions: Record<string, "deleted"> }

export const backgroundJobStore = Context.Service<SliceStoreService<BackgroundJobState, BackgroundJobState, unknown>>(
  "@ocpp/runtime/BackgroundJobStore",
)

export const createBackgroundJobState = (): BackgroundJobState => ({ sessions: {} })

const backgroundStarted = sessionEvent("session-background-started")
const backgroundSettled = sessionEvent("session-background-settled")

const { notificationID: _, sessionID: _sessionID, ...outcome } = SessionFact.BackgroundSettled.data.fields
const { sessionID: _owner, ...marker } = SessionFact.BackgroundStarted.data.fields
const input = Schema.toStandardSchemaV1(
  Schema.Struct({
    ...marker,
    // How the job ended, when it ended before it went to the background.
    settled: Schema.optional(Schema.Struct(outcome)),
  }),
)

// The Session a job's notification arrives in owns its marker: a shell's own
// Session, or the parent of a subagent or a Code Mode run.
const owner = (recovery: SessionFact.BackgroundRecovery) =>
  recovery.kind === "shell" ? recovery.sessionID : recovery.parentSessionID

export const backgroundJob = implementCommand(specification)
  .inputSchema(input)
  .store(backgroundJobStore, { stateVersion: 2 })
  .consistencyKeys({
    notification: (command) => command.notificationID,
    session: (command) => owner(command.recovery),
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
  })
  .apply(backgroundStarted, async () => {})
  .apply(backgroundSettled, async () => {})
  .handle(async (command, state) => {
    const { settled, ...started } = command
    const sessionID = owner(command.recovery)
    // A deleted Session's job is not recoverable: nothing would deliver its
    // notification.
    if (state.sessions[sessionID] === "deleted") throw new CommandRejection("session-deleted", "Session deleted")
    return [
      backgroundStarted.create({ ...started, sessionID }),
      ...(settled === undefined
        ? []
        : [backgroundSettled.create({ notificationID: started.notificationID, sessionID, ...settled })]),
    ]
  })
