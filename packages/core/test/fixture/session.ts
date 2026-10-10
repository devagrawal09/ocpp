import { Effect, Schema } from "effect"
import { Bus } from "@ocpp/core/bus"
import { Project } from "@ocpp/core/project"
import { SessionEvent } from "@ocpp/core/session/event"
import { SpecterRejection } from "@ocpp/core/specter/rejection"
import { AbsolutePath } from "@ocpp/schema/schema"
import { SessionID } from "@ocpp/schema/session-id"
import type { WorkspaceID } from "@ocpp/schema/workspace-id"

const encode = Schema.encodeSync(SessionEvent.Created.data)

/**
 * Records a Session as Session.create does, through the runtime's createSession, without resolving a
 * project: tests give the identity they need. Recording one that exists keeps the first.
 */
export const recordSession = (input: {
  readonly id: string
  readonly directory: string
  readonly workspaceID?: WorkspaceID
  readonly projectID?: Project.ID
  readonly parentID?: string
  readonly title?: string
  readonly slug?: string
  readonly version?: string
  readonly agent?: SessionEvent.Created["data"]["agent"]
  readonly model?: SessionEvent.Created["data"]["model"]
  readonly metadata?: SessionEvent.Created["data"]["metadata"]
}) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    yield* bus.runtime
      .command({
        type: "createSession",
        payload: {
          session: encode({
            sessionID: SessionID.make(input.id),
            projectID: input.projectID ?? Project.ID.global,
            location: { directory: AbsolutePath.make(input.directory), workspaceID: input.workspaceID },
            slug: input.slug ?? input.id,
            version: input.version ?? "test",
            parentID: input.parentID === undefined ? undefined : SessionID.make(input.parentID),
            title: input.title,
            agent: input.agent,
            model: input.model,
            metadata: input.metadata,
          }),
        },
      })
      .pipe(
        Effect.catchIf(
          (error) => SpecterRejection.reason(error) === "Session already exists",
          () => Effect.void,
        ),
        Effect.orDie,
      )
  })

const encodeRevert = Schema.encodeSync(SessionEvent.RevertEvent.Staged.data)

/** Stages a revert through the runtime's stageRevert, without restoring files. */
export const stageRevert = (input: typeof SessionEvent.RevertEvent.Staged.Type.data) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    yield* bus.runtime.command({ type: "stageRevert", payload: encodeRevert(input) }).pipe(Effect.orDie)
  })

const encodeForked = Schema.encodeSync(SessionEvent.Forked.data)

/**
 * Forks a Session through the runtime's forkSession: the child is created in /project, as the parent of a
 * test is, and the fork projects the parent's history into it.
 */
export const forkSession = (input: typeof SessionEvent.Forked.Type.data) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const { sessionID, ...fork } = encodeForked(input)
    yield* bus.runtime
      .command({
        type: "forkSession",
        payload: {
          session: {
            sessionID,
            projectID: Project.ID.global,
            location: { directory: "/project" },
            slug: sessionID,
            version: "test",
          },
          ...fork,
        },
      })
      .pipe(Effect.orDie)
  })

/** Clears or commits a Session's staged revert through the runtime's Command. */
export const revert = (type: "clearRevert" | "commitRevert", sessionID: string) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    yield* bus.runtime.command({ type, payload: { sessionID } }).pipe(Effect.orDie)
  })

const encodeMoved = Schema.encodeSync(SessionEvent.Moved.data)

/** Moves a Session now, through the runtime's moveSession, as one whose directory is gone moves. */
export const moveSession = (input: typeof SessionEvent.Moved.Type.data) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    yield* bus.runtime.command({ type: "moveSession", payload: encodeMoved(input) }).pipe(Effect.orDie)
  })
