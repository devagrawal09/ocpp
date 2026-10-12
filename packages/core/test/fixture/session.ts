import { Effect, Schema } from "effect"
import { Bus } from "@ocpp/core/bus"
import { Database } from "@ocpp/core/database/database"
import { Project } from "@ocpp/core/project"
import { SessionEvent } from "@ocpp/core/session/event"
import { SessionFork } from "@ocpp/core/session/fork"
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
    yield* bus
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
          (error) => SpecterRejection.code(error) === "session-already-exists",
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
    yield* bus.command({ type: "stageRevert", payload: encodeRevert(input) }).pipe(Effect.orDie)
  })

const encodeForked = Schema.encodeSync(SessionEvent.Forked.data)

/**
 * Forks a Session through the runtime's forkSession, as Session.fork does: the child is created in /project, as the
 * parent of a test is, and records what it inherits of the parent's projection through the boundary (its history,
 * notebook, instruction values and entries, tool list), unless the input gives its instruction values or entries.
 */
export const forkSession = (input: typeof SessionEvent.Forked.Type.data) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const { db } = yield* Database.Service
    const inherited = yield* SessionFork.inherit(db, { parentID: input.parentID, boundary: input.boundary })
    if (!inherited) return yield* Effect.die(new Error(`Fork parent not found: ${input.parentID}`))
    const { sessionID, ...fork } = encodeForked({
      instructions: inherited.instructions,
      instructionEntries: inherited.instructionEntries,
      tools: inherited.tools,
      ...input,
    })
    yield* bus
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
          ...(inherited.blobs === undefined ? {} : { blobs: inherited.blobs }),
          history: inherited.history,
          notebook: inherited.notebook,
        },
      })
      .pipe(Effect.orDie)
  })

/**
 * Clears or commits a Session's staged revert through the runtime's Command. A commit cuts the Code Mode
 * executions named, as the host resolves them from where their messages sit.
 */
export const revert = (type: "clearRevert" | "commitRevert", sessionID: string, executions?: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    yield* bus
      .command(
        type === "commitRevert" && executions !== undefined
          ? { type, payload: { sessionID: SessionID.make(sessionID), executions } }
          : { type, payload: { sessionID: SessionID.make(sessionID) } },
      )
      .pipe(Effect.orDie)
  })

const encodeMoved = Schema.encodeSync(SessionEvent.Moved.data)

/** Moves a Session now, through the runtime's moveSession, as one whose directory is gone moves. */
export const moveSession = (input: typeof SessionEvent.Moved.Type.data) =>
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    yield* bus.command({ type: "moveSession", payload: encodeMoved(input) }).pipe(Effect.orDie)
  })
