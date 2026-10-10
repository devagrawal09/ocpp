import { describe, expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Bus } from "@ocpp/core/bus"
import { Location } from "@ocpp/core/location"
import { Project } from "@ocpp/core/project"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { SessionProjector } from "@ocpp/core/session/projector"
import { SessionStore } from "@ocpp/core/session/store"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { TestStepHost } from "./fixture/step-host"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const steps = TestStepHost.make()
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [[Project.node, globalProjectNode], steps.replacement],
  ),
)

describe("Session.wait", () => {
  it.effect("resolves once the Session's execution settles", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ location })

      // An idle Session: nothing to wait for.
      yield* sessions.wait(session.id)

      const busy = yield* steps.busy(session.id)
      const waiting = yield* sessions.wait(session.id).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(waiting.pollUnsafe()).toBeUndefined()
      yield* busy.release
      yield* Fiber.join(waiting)
      expect(yield* sessions.active).toEqual(new Set())
    }),
  )
})
