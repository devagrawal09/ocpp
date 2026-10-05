import path from "path"
import { rm } from "node:fs/promises"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Global } from "@ocpp/util/global"
import { Agent } from "@ocpp/core/agent"
import { Bus } from "@ocpp/core/bus"
import { Database } from "@ocpp/core/database/database"
import { Job } from "@ocpp/core/job"
import { Location } from "@ocpp/core/location"
import { LocationServiceMap } from "@ocpp/core/location-services"
import { PluginRuntime } from "@ocpp/core/plugin/runtime"
import { PluginSupervisor } from "@ocpp/core/plugin/supervisor-service"
import { Project } from "@ocpp/core/project"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { SessionEnvironment } from "@ocpp/core/session/environment"
import { SessionExecution } from "@ocpp/core/session/execution"
import { SessionInbox } from "@ocpp/core/session/inbox"
import { SessionModelTransport } from "@ocpp/core/session/model-transport"
import { SessionProjector } from "@ocpp/core/session/projector"
import { SessionStore } from "@ocpp/core/session/store"
import { Tool } from "@ocpp/core/tool"
import { ToolInit } from "@ocpp/core/tool/init"
import { ToolLists } from "@ocpp/core/tool/lists"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { tempGlobalLayer } from "./fixture/global"
import { tmpdirScoped } from "./fixture/tmpdir"

const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    isActive: () => Effect.succeed(false),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
  }),
)
const transport = Layer.succeed(
  SessionModelTransport.Service,
  SessionModelTransport.Service.of({
    bind: () => ({ execute: () => Effect.die("Unexpected WebSocket execution") }),
    close: () => Effect.void,
    closeAll: Effect.void,
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
      PluginRuntime.providerNode,
      Global.node,
    ]),
    [
      [Project.node, globalProjectNode],
      [SessionExecution.node, execution],
      [SessionModelTransport.node, transport],
      [Global.node, tempGlobalLayer],
    ],
  ),
)

const build = Agent.ID.make("build")
const plan = Agent.ID.make("plan")

/** A top-level Session in a fresh directory, with the project's .ocpp/init.ts when given. */
const setup = (project?: string) =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    if (project !== undefined)
      yield* Effect.promise(() => Bun.write(path.join(directory.path, ".ocpp", ToolLists.FILE), project))
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      location: Location.Ref.make({ directory: AbsolutePath.make(directory.path) }),
    })
    const locations = yield* LocationServiceMap.Service
    const within = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const plugins = yield* PluginSupervisor.Service
        yield* plugins.flush
        return yield* effect
      }).pipe(Effect.provide(locations.get(session.location)))
    return { session, sessions, within }
  })

/** Writes the global ~/.config/ocpp/init.ts for one test. */
const globalInit = (source: string) =>
  Effect.gen(function* () {
    const global = yield* Global.Service
    const file = path.join(global.config, ToolLists.FILE)
    yield* Effect.acquireRelease(
      Effect.promise(() => Bun.write(file, source)),
      () => Effect.promise(() => rm(file, { force: true })),
    )
  })

/** The catalog paths a Session's agent works with, as a request would build them. */
const catalog = (context: Effect.Success<ReturnType<typeof setup>>, session: Session.Info, agent: Agent.ID) =>
  context.within(
    Effect.gen(function* () {
      const lists = yield* ToolLists.Service
      const registry = yield* Tool.Service
      const snapshot = yield* registry.snapshot(yield* lists.select(session, agent), session.id)
      return { paths: (snapshot.codeModeCatalog ?? []).map((tool) => tool.path), notice: snapshot.notice }
    }),
  )

describe("ToolLists", () => {
  it.live("a project init.ts wins over the global one, and they are not merged", () =>
    Effect.gen(function* () {
      const project = "return { build: [tools.grep] }"
      const context = yield* setup(project)
      yield* globalInit("return { build: [tools.read], plan: [tools.glob] }")
      const selected = yield* context.within(
        ToolLists.Service.pipe(Effect.flatMap((lists) => lists.select(context.session, build))),
      )
      const file = path.join(context.session.location.directory, ".ocpp", ToolLists.FILE)
      expect(selected).toEqual({ init: { source: project, agent: build, file } })
      expect((yield* catalog(context, context.session, build)).paths).toEqual(["grep", "notebook.inspect", "notebook.list"])
      // The project's init.ts has no plan list, and the global one does not fill it in. The notice names the file.
      expect(yield* catalog(context, context.session, plan)).toEqual({
        paths: [],
        notice: `${file} returns no tool list for the plan agent, so it has no tools. This session has no tools until that is fixed.`,
      })
    }),
  )

  it.live("the global init.ts applies to a project without one", () =>
    Effect.gen(function* () {
      const context = yield* setup()
      yield* globalInit("return { build: [tools.read, tools.subagent] }")
      expect((yield* catalog(context, context.session, build)).paths).toEqual([
        "notebook.inspect",
        "notebook.list",
        "read",
        "subagent",
        "subagent.models",
      ])
    }),
  )

  it.live("without init.ts, build has every tool and plan reads, searches and asks", () =>
    Effect.gen(function* () {
      const context = yield* setup()
      const lists = yield* context.within(ToolLists.Service)
      expect(yield* lists.select(context.session, build)).toEqual({})
      const everything = (yield* catalog(context, context.session, build)).paths
      expect(everything).toEqual(expect.arrayContaining(["edit", "read", "shell", "write"]))
      const planned = (yield* catalog(context, context.session, plan)).paths
      expect(planned).toEqual(expect.arrayContaining(["glob", "grep", "question", "read"]))
      expect(planned.filter((item) => ["edit", "patch", "shell", "write"].includes(item))).toEqual([])
      expect(planned.every((item) => everything.includes(item))).toBe(true)
    }),
  )

  it.live("a subagent's tools are exactly the paths its caller passed, whatever init.ts says", () =>
    Effect.gen(function* () {
      const context = yield* setup("return { build: [tools.read, tools.grep] }")
      const created = yield* context.sessions.create({ parentID: context.session.id })
      expect((yield* catalog(context, created, build)).paths).toEqual([])
      yield* context.sessions.selectTools({ sessionID: created.id, tools: ["glob", "shell"] })
      const child = yield* context.sessions.get(created.id)
      expect(child.tools).toEqual(["glob", "shell"])
      // The notebook tools only read the child's own notebook, so every Code Mode catalog pins them.
      expect((yield* catalog(context, child, build)).paths).toEqual([
        "glob",
        "notebook.inspect",
        "notebook.list",
        "shell",
      ])
    }),
  )

  it.live("an init.ts that fails leaves the Session without tools and says why once in its timeline", () =>
    Effect.gen(function* () {
      const context = yield* setup('throw new Error("no lists today")')
      const listed = yield* catalog(context, context.session, build)
      expect(listed.paths).toEqual([])
      expect(listed.notice).toContain("init.ts failed:")
      expect(listed.notice).toContain("no lists today")
      const lists = yield* context.within(ToolLists.Service)
      yield* lists.report(context.session.id, listed.notice)
      yield* lists.report(context.session.id, listed.notice)
      const shown = () =>
        context.sessions
          .inbox(context.session.id)
          .pipe(Effect.map((items) => items.flatMap((item) => (item.type === "synthetic" ? [item.payload.text] : []))))
      expect(yield* shown()).toEqual([listed.notice ?? ""])
      // Once fixed the problem clears, and a later one is shown again.
      yield* lists.report(context.session.id, undefined)
      yield* lists.report(context.session.id, listed.notice)
      expect(yield* shown()).toHaveLength(2)
    }),
  )

  it.live(
    "an init.ts that never returns times out as a problem, and the Session has no tools",
    () =>
      Effect.gen(function* () {
        const context = yield* setup("let n = 0\nwhile (true) { n = n + 1 }\nreturn { build: [tools.read] }")
        const file = path.join(context.session.location.directory, ".ocpp", ToolLists.FILE)
        const started = Date.now()
        expect(yield* catalog(context, context.session, build)).toEqual({
          paths: [],
          notice: `${file} did not return its tool lists within 3 seconds; look for a loop that never ends. This session has no tools until that is fixed.`,
        })
        expect(Date.now() - started).toBeGreaterThanOrEqual(ToolInit.TIMEOUT_MS)
      }),
    15_000,
  )

  it.live("an .ocpp/init.ts created after the Location loaded applies at the next selection", () =>
    Effect.gen(function* () {
      const context = yield* setup()
      const lists = yield* context.within(ToolLists.Service)
      expect(yield* lists.select(context.session, build)).toEqual({})
      const file = path.join(context.session.location.directory, ".ocpp", ToolLists.FILE)
      yield* Effect.promise(() => Bun.write(file, "return { build: [tools.grep] }"))
      expect(yield* lists.select(context.session, build)).toEqual({
        init: { source: "return { build: [tools.grep] }", agent: build, file },
      })
      expect((yield* catalog(context, context.session, build)).paths).toEqual(["grep", "notebook.inspect", "notebook.list"])
    }),
  )

  it.live(
    "a fork keeps a stored list, so a fork of a subagent keeps its tools, and a top-level fork uses init.ts",
    () =>
      Effect.gen(function* () {
        const context = yield* setup("return { build: [tools.read, tools.grep] }")
        const { db } = yield* Database.Service
        const bus = yield* Bus.Service
        const fork = (sessionID: Session.ID) =>
          Effect.gen(function* () {
            yield* context.sessions.prompt({ sessionID, text: "Fork here", resume: false })
            yield* SessionInbox.promote(db, bus, sessionID, "steer")
            return yield* context.sessions.fork({ sessionID, boundary: { type: "through" } })
          })

        const child = yield* context.sessions.create({ parentID: context.session.id })
        yield* context.sessions.selectTools({ sessionID: child.id, tools: ["glob"] })
        const forkedChild = yield* fork(child.id)
        expect(forkedChild.parentID).toBeUndefined()
        expect(forkedChild.tools).toEqual(["glob"])
        expect((yield* catalog(context, forkedChild, build)).paths).toEqual([
          "glob",
          "notebook.inspect",
          "notebook.list",
        ])

        const forkedTop = yield* fork(context.session.id)
        expect(forkedTop.tools).toBeUndefined()
        expect((yield* catalog(context, forkedTop, build)).paths).toEqual([
          "grep",
          "notebook.inspect",
          "notebook.list",
          "read",
        ])
      }),
  )
})
