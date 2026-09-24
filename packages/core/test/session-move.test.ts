import { describe, expect } from "bun:test"
import path from "path"
import { mkdir, rm } from "fs/promises"
import { Effect, Layer, LayerMap } from "effect"
import { Worktree } from "@ocpp/schema/worktree"
import { Bus } from "@ocpp/core/bus"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { Location } from "@ocpp/core/location"
import { LocationServiceMap } from "@ocpp/core/location-service-map"
import type { LocationServices } from "@ocpp/core/location-services"
import { Project } from "@ocpp/core/project"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { SessionEvent } from "@ocpp/core/session/event"
import { SessionExecution } from "@ocpp/core/session/execution"
import { SessionProjector } from "@ocpp/core/session/projector"
import { SessionStore } from "@ocpp/core/session/store"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      [Project.node, globalProjectNode],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const unavailableLocations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(
    () => Layer.effectDiscard(Effect.fail(new Error("broken location"))) as unknown as Layer.Layer<LocationServices>,
  ),
)
const itWithUnavailableDestination = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      [Project.node, globalProjectNode],
      [SessionExecution.node, SessionExecution.noopLayer],
      [LocationServiceMap.node, unavailableLocations],
    ],
  ),
)

describe("Session.move", () => {
  itWithUnavailableDestination.effect("rejects an unavailable destination before admitting the move", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const source = AbsolutePath.make(path.join(tmp.path, "source"))
          const destination = AbsolutePath.make(path.join(tmp.path, "destination"))
          yield* Effect.promise(() => Promise.all([mkdir(source), mkdir(destination)]))
          const created = yield* session.create({ location: Location.Ref.make({ directory: source }) })

          const error = yield* session.move({ sessionID: created.id, directory: destination }).pipe(Effect.flip)

          expect(error).toEqual(new Session.DestinationUnavailableError({ directory: destination }))
          expect((yield* session.get(created.id)).location.directory).toBe(source)
          expect(yield* session.inbox(created.id)).toEqual([])
        }),
      ),
    ),
  )

  it.effect("applies a move immediately when the source directory no longer exists", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const destination = AbsolutePath.make(tmp.path)
          const source = path.join(tmp.path, "source")
          yield* Effect.promise(() => mkdir(source))
          const created = yield* session.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(source) }),
          })

          yield* session.move({ sessionID: created.id, directory: destination })
          expect((yield* session.get(created.id)).location.directory).toBe(AbsolutePath.make(source))
          expect(yield* session.inbox(created.id)).toHaveLength(1)

          yield* Effect.promise(() => rm(source, { recursive: true }))
          yield* session.move({ sessionID: created.id, directory: destination })

          expect((yield* session.get(created.id)).location.directory).toBe(destination)
          expect(yield* session.inbox(created.id)).toEqual([])

          yield* session.move({ sessionID: created.id, directory: destination })
          expect(yield* session.inbox(created.id)).toHaveLength(1)

          yield* Effect.promise(() => mkdir(path.join(tmp.path, "other")))
          const steered = yield* session.create({
            location: Location.Ref.make({ directory: AbsolutePath.make(path.join(tmp.path, "other")) }),
          })
          yield* session.move({ sessionID: steered.id, directory: destination, delivery: "queue" })
          expect(yield* session.inbox(steered.id)).toMatchObject([{ type: "move", delivery: "queue" }])
        }),
      ),
    ),
  )

  it.effect("keeps a moved session out of its former directory's new identity", () =>
    tmpdirScoped().pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const bus = yield* Bus.Service
          const previous = AbsolutePath.make(path.join(tmp.path, "previous"))
          const destination = AbsolutePath.make(tmp.path)
          const created = yield* session.create({ location: Location.Ref.make({ directory: previous }) })

          // Moves are admitted through the inbox and applied by the drain;
          // publish the applied move directly since execution is a no-op here.
          yield* bus.publish(SessionEvent.Moved, {
            sessionID: created.id,
            location: Location.Ref.make({ directory: destination }),
            projectID: Project.ID.global,
          })
          // The former directory becomes a project after the session left it.
          yield* bus.publish(Worktree.Event.Resolved, {
            projectID: Project.ID.make("adopting"),
            directory: previous,
            previous: Project.ID.global,
          })

          expect(yield* session.get(created.id)).toMatchObject({
            projectID: Project.ID.global,
            location: { directory: destination },
            subpath: undefined,
          })
        }),
      ),
    ),
  )
})
