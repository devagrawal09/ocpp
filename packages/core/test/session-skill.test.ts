import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, LayerMap } from "effect"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { FSUtil } from "@ocpp/util/fs-util"
import { Bus } from "@ocpp/core/bus"
import { Image } from "@ocpp/core/image"
import { Location } from "@ocpp/core/location"
import { LocationServiceMap } from "@ocpp/core/location-service-map"
import type { LocationServices } from "@ocpp/core/location-services"
import { Project } from "@ocpp/core/project"
import { PluginSupervisor } from "@ocpp/core/plugin/supervisor-service"
import { PluginHooks } from "@ocpp/core/plugin/hooks"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { SessionMessage } from "@ocpp/core/session/message"
import { SessionPrompt } from "@ocpp/core/session/prompt"
import { SessionProjector } from "@ocpp/core/session/projector"
import { SessionStore } from "@ocpp/core/session/store"
import { SessionInbox } from "@ocpp/core/session/inbox"
import { Skill } from "@ocpp/core/skill"
import { Reference } from "@ocpp/core/reference"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { TestStepHost } from "./fixture/step-host"

const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const info = Skill.Info.make({
  id: Skill.ID.make("effect"),
  name: Skill.Name.make("Effect"),
  description: "Effect guidance",
  location: AbsolutePath.make(path.resolve("/skills/effect.md")),
  content: "Use Effect",
})
const locations = makeGlobalNode({
  service: LocationServiceMap.Service,
  layer: Layer.effect(
    LocationServiceMap.Service,
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const skills = SessionPrompt.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            LayerNode.compile(LayerNode.group([PluginHooks.node, Image.node])),
            Layer.succeed(FSUtil.Service, fs),
            Layer.mock(Skill.Service, {
              get: (id) => Effect.succeed(id === info.id ? info : undefined),
              list: () => Effect.succeed([info]),
            }),
            Layer.succeed(PluginSupervisor.Service, { flush: Effect.void }),
            Layer.mock(Reference.Service, { refresh: () => Effect.void }),
          ),
        ),
      )
      return yield* LayerMap.make(
        (_ref: Location.Ref) =>
          // These tests need skill activation and prompt preparation from the same location services.
          // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
          skills as unknown as Layer.Layer<LocationServices>,
      )
    }),
  ),
  deps: [FSUtil.node],
})

const steps = TestStepHost.make()
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [[LocationServiceMap.node, locations], [Project.node, globalProjectNode], steps.replacement],
  ),
)

describe("Session.skill", () => {
  it.effect("materializes mentioned skills on their owning prompt", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ location })
      const id = SessionMessage.ID.make("msg_skill_attachment")

      yield* sessions.prompt({
        id,
        sessionID: session.id,
        text: "Apply @effect and @effect",
        skills: [
          { id: Skill.ID.make("effect"), mention: { start: 6, end: 13, text: "@effect" } },
          { id: Skill.ID.make("effect"), mention: { start: 18, end: 25, text: "@effect" } },
        ],
        resume: false,
      })
      expect(yield* sessions.messages({ sessionID: session.id })).toEqual([])
      yield* sessions.resume(session.id)

      expect(yield* sessions.messages({ sessionID: session.id })).toEqual([
        expect.objectContaining({
          id,
          type: "user",
          text: "Apply @effect and @effect",
          skills: [
            {
              id: "effect",
              name: "Effect",
              text: Skill.toModelOutput(info, []),
              mention: { start: 6, end: 13, text: "@effect" },
            },
            {
              id: "effect",
              name: "Effect",
              mention: { start: 18, end: 25, text: "@effect" },
            },
          ],
        }),
      ])
    }),
  )

  it.effect("excludes mentioned skills when forking before their prompt", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ location })
      const initial = SessionMessage.ID.make("msg_before_skill_attachment")
      const selected = SessionMessage.ID.make("msg_fork_skill_attachment")

      yield* sessions.prompt({ id: initial, sessionID: session.id, text: "Before the skill", resume: false })
      yield* sessions.resume(session.id)
      yield* sessions.prompt({
        id: selected,
        sessionID: session.id,
        text: "Apply @effect",
        skills: [{ id: info.id, mention: { start: 6, end: 13, text: "@effect" } }],
        resume: false,
      })
      yield* sessions.resume(session.id)
      const forked = yield* sessions.fork({ sessionID: session.id, boundary: { type: "before", messageID: selected } })

      expect(yield* sessions.messages({ sessionID: forked.id })).toEqual([
        expect.objectContaining({ type: "user", text: "Before the skill" }),
      ])
    }),
  )

  it.effect("projects the caller-supplied message ID", () =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ location })
      const id = SessionMessage.ID.make("msg_caller_skill")

      yield* sessions.skill({ id, sessionID: session.id, skill: Skill.ID.make("effect"), resume: false })

      expect(yield* sessions.messages({ sessionID: session.id })).toContainEqual(
        expect.objectContaining({ id, type: "skill", skill: "effect", name: "Effect", text: "Use Effect" }),
      )
    }),
  )
})
