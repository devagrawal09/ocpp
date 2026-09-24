import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Database } from "@ocpp/core/database/database"
import { Bus } from "@ocpp/core/bus"
import { Job } from "@ocpp/core/job"
import { Location } from "@ocpp/core/location"
import { Project } from "@ocpp/core/project"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { SessionExecution } from "@ocpp/core/session/execution"
import { SessionMessage } from "@ocpp/core/session/message"
import { SessionModelTransport } from "@ocpp/core/session/model-transport"
import { SessionProjector } from "@ocpp/core/session/projector"
import { SessionStore } from "@ocpp/core/session/store"
import { SessionEnvironment } from "@ocpp/core/session/environment"
import { LocationServiceMap } from "@ocpp/core/location-services"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { tmpdirScoped } from "./fixture/tmpdir"

const closed: Session.ID[] = []
const wakes: Session.ID[] = []
let closeStarted: Deferred.Deferred<void> | undefined
let closeGate: Deferred.Deferred<void> | undefined
const transport = Layer.succeed(
  SessionModelTransport.Service,
  SessionModelTransport.Service.of({
    bind: () => ({ execute: () => Effect.die("Unexpected WebSocket execution") }),
    close: (sessionID) =>
      Effect.sync(() => closed.push(sessionID)).pipe(
        Effect.andThen(Effect.suspend(() => (closeStarted ? Deferred.succeed(closeStarted, undefined) : Effect.void))),
        Effect.andThen(Effect.suspend(() => (closeGate ? Deferred.await(closeGate) : Effect.void))),
      ),
    closeAll: Effect.void,
  }),
)
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    isActive: () => Effect.succeed(false),
    resume: () => Effect.void,
    wake: (sessionID) => Effect.sync(() => wakes.push(sessionID)),
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      SessionEnvironment.node,
      Job.node,
      Session.node,
      LocationServiceMap.node,
    ]),
    [
      [Project.node, globalProjectNode],
      [SessionExecution.node, execution],
      [SessionModelTransport.node, transport],
    ],
  ),
)

describe("Session.remove", () => {
  it.effect("removes a session and its children", () =>
    Effect.gen(function* () {
      const temporary = yield* tmpdirScoped()
      const location = Location.Ref.make({ directory: AbsolutePath.make(temporary.path) })
      const session = yield* Session.Service
      const jobs = yield* Job.Service
      const parent = yield* session.create({ location })
      const child = yield* session.create({ parentID: parent.id })
      yield* session.environment({ sessionID: parent.id, variables: { SESSION_ENV: "parent" } })
      yield* session.environment({ sessionID: child.id, variables: { SESSION_ENV: "child" } })
      const locations = yield* LocationServiceMap.Service
      yield* Effect.acquireRelease(locations.contextEffect(location), () => locations.invalidate(location))
      closed.length = 0
      wakes.length = 0
      const notificationID = SessionMessage.ID.create()
      yield* jobs.startLimited({
        id: "exe_removed_session",
        type: "codemode",
        ownerSessionID: parent.id,
        maxConcurrent: 4,
        notificationID,
        recovery: {
          kind: "codemode",
          parentSessionID: parent.id,
          assistantMessageID: SessionMessage.ID.create(),
          toolCallID: "call-removed-session",
        },
        run: Effect.never,
      })
      yield* jobs.background("exe_removed_session")
      const completedNotificationID = SessionMessage.ID.create()
      yield* jobs.startLimited({
        id: "exe_settled_removed_session",
        type: "codemode",
        ownerSessionID: parent.id,
        maxConcurrent: 4,
        notificationID: completedNotificationID,
        recovery: {
          kind: "codemode",
          parentSessionID: parent.id,
          assistantMessageID: SessionMessage.ID.create(),
          toolCallID: "call-settled-removed-session",
        },
        run: Effect.succeed("2"),
      })
      yield* jobs.wait({ id: "exe_settled_removed_session" })
      yield* jobs.background("exe_settled_removed_session")
      expect(yield* jobs.pendingBackground).toMatchObject([
        { notificationID },
        { notificationID: completedNotificationID, status: "completed" },
      ])

      closeStarted = yield* Deferred.make<void>()
      closeGate = yield* Deferred.make<void>()
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closeStarted = undefined
          closeGate = undefined
        }),
      )
      const removing = yield* session.remove(parent.id).pipe(Effect.forkScoped)
      yield* Deferred.await(closeStarted)
      yield* session.synthetic({ sessionID: parent.id, text: "Terminal notification during removal" })
      expect(wakes).toEqual([])
      yield* Deferred.succeed(closeGate, undefined)
      yield* Fiber.join(removing)
      closeStarted = undefined
      closeGate = undefined

      expect((yield* session.list()).data).toEqual([])
      expect(closed).toEqual([parent.id, child.id])
      expect((yield* jobs.wait({ id: "exe_removed_session" })).info?.status).toBe("cancelled")
      expect((yield* jobs.wait({ id: "exe_settled_removed_session" })).info?.status).toBe("completed")
      expect(yield* jobs.pendingBackground).toEqual([])
      const environments = yield* SessionEnvironment.Service
      expect(yield* environments.get(parent.id)).toBeUndefined()
      expect(yield* environments.get(child.id)).toBeUndefined()
      expect(yield* Effect.result(session.get(parent.id))).toMatchObject({ _tag: "Failure" })
      expect(yield* Effect.result(session.get(child.id))).toMatchObject({ _tag: "Failure" })
    }),
  )

  it.effect("fails when the session does not exist", () =>
    Effect.gen(function* () {
      const session = yield* Session.Service
      const sessionID = Session.ID.make("ses_missing")

      expect(yield* Effect.result(session.remove(sessionID))).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "Session.NotFoundError", sessionID },
      })
    }),
  )
})
