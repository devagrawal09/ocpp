import { describe, expect } from "bun:test"
import { ToolHandle } from "@ocpp/codemode"
import { Model } from "@ocpp/schema/model"
import { Provider } from "@ocpp/schema/provider"
import { ExternalAgentStream } from "../src/external-agent/stream"
import { ExternalSession } from "@ocpp/schema/external-session"
import { Effect, Fiber, Layer, Schema, Stream } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { makeLocationNode } from "@ocpp/util/effect/app-node"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Global } from "@ocpp/util/global"
import { FSUtil } from "@ocpp/util/fs-util"
import { Agent } from "../src/agent"
import { Bus } from "../src/bus"
import { Config } from "../src/config"
import { Database } from "../src/database/database"
import { ExternalAgentDriver } from "../src/external-agent/driver"
import { ExternalAgentSession } from "../src/external-agent/session"
import { ExternalSessionTable } from "../src/external-agent/sql"
import { LocationServiceMap } from "../src/location-service-map"
import { Permission } from "../src/permission"
import { PluginRuntime } from "../src/plugin/runtime"
import { PluginSupervisor } from "../src/plugin/supervisor"
import { AbsolutePath } from "../src/schema"
import { Session } from "../src/session"
import { SessionExecution } from "../src/session/execution"
import { SessionEvent } from "../src/session/event"
import { ExternalAgentTool } from "../src/tool/plugin/external-agent"
import { Tool } from "../src/tool"
import { testEffect } from "./lib/effect"
import { executeTool, registerToolPlugin, toolIdentity } from "./lib/tool"
import { tempGlobalLayer } from "./fixture/global"
import { tmpdirScoped } from "./fixture/tmpdir"
import { eq } from "drizzle-orm"

const vendor = new Map<string, number>()
const runs: ExternalAgentDriver.Options[] = []
const checks: string[] = []
const plugin = ExternalAgentTool.make({
  available: async (provider) => {
    checks.push(provider)
    return true
  },
  driver: async (provider) => ({
    provider,
    inspect: async (_directory, id) => (vendor.has(id) ? String(vendor.get(id)) : undefined),
    async run(options) {
      runs.push(options)
      const id =
        options.vendorSessionID && vendor.has(options.vendorSessionID) ? options.vendorSessionID : crypto.randomUUID()
      if (id === options.vendorSessionID) ExternalAgentDriver.check(options.checkpoint, String(vendor.get(id)))
      await options.linked(id)
      if (options.message === "native")
        await options.authorize(
          provider === "codex" ? "workspace" : provider === "claude" ? "Write" : "write",
          { path: options.directory + "/file" },
          options.signal,
        )
      if (options.message.startsWith("outside:"))
        await options.authorize("Read", { path: options.message.slice(8) }, options.signal)
      if (options.message === "shell")
        await options.authorize("Bash", { command: "echo allowed; rm forbidden" }, options.signal)
      await options.emit({ type: "step-start", id })
      await options.emit({ type: "reasoning", id: "r", delta: "Consider the task." })
      await options.emit({ type: "text", id: "t", delta: "Working." })
      if (options.message === "fail") throw new Error("fixture provider failed")
      if (options.message === "wait") {
        options.signal.throwIfAborted()
        await new Promise<void>((_resolve, reject) =>
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        )
        return
      }
      if (options.gateway.definitions.some((tool) => tool.name === "submit_result")) {
        const value = await Effect.runPromise(
          options.gateway.invoke("execute", {
            code: 'const value = tools.count({ count: input.count }); const submitted = tools.submit_result({ message: "done", output: { count: value, token: input.token } })',
          }),
        )
        expect(JSON.stringify(value)).not.toContain("private-token")
        await options.emit({
          type: "tool-start",
          id: "submit",
          name: "submit_result",
          input: { message: "done", output: { token: "private-token" } },
        })
        await options.emit({ type: "tool-end", id: "submit", output: "Result submitted." })
      }
      await options.emit({ type: "usage", input: 12, output: 8, cacheRead: 3 })
      await options.emit({ type: "step-end" })
      vendor.set(id, (vendor.get(id) ?? 0) + 1)
      await options.checkpointed(String(vendor.get(id)))
    },
  }),
})
const supervisor = makeLocationNode({
  service: PluginSupervisor.Service,
  layer: Layer.effect(
    PluginSupervisor.Service,
    registerToolPlugin(plugin).pipe(Effect.as(PluginSupervisor.Service.of({ flush: Effect.void }))),
  ),
  deps: [
    Agent.node,
    PluginRuntime.node,
    ExternalAgentSession.node,
    Bus.node,
    Config.node,
    FSUtil.node,
    Permission.node,
    Tool.node,
  ],
})
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      Session.node,
      SessionExecution.node,
      ExternalAgentSession.node,
      PluginRuntime.providerNode,
      LocationServiceMap.node,
    ]),
    [
      [Global.node, tempGlobalLayer],
      [PluginSupervisor.node, supervisor],
      [Bus.node, Bus.configured({ persist: true })],
    ],
  ),
)

const setup = Effect.gen(function* () {
  const directory = yield* tmpdirScoped()
  const sessions = yield* Session.Service
  const parent = yield* sessions.create({
    location: { directory: AbsolutePath.make(directory.path) },
    agent: toolIdentity.agent,
  })
  const locations = yield* LocationServiceMap.Service
  const scope = locations.get(parent.location)
  yield* PluginSupervisor.Service.use((service) => service.flush).pipe(Effect.provide(scope))
  const agents = yield* Agent.Service.pipe(Effect.provide(scope))
  yield* agents.transform((draft) =>
    draft.update(toolIdentity.agent, (agent) => {
      agent.permissions.push({ action: "*", resource: "*", effect: "allow" })
    }),
  )
  const tools = yield* Tool.Service.pipe(Effect.provide(scope))
  const external = yield* ExternalAgentSession.Service
  return { directory, parent, sessions, tools, external, agents }
})
const output = Schema.decodeUnknownSync(ExternalAgentTool.Output)

describe("external-agent tools", () => {
  for (const provider of ExternalSession.Provider.literals)
    it.live(`${provider}: full private contract, canonical child, exact resume and missing-session rebuild`, () =>
      Effect.gen(function* () {
        const env = yield* setup
        const worktree = yield* tmpdirScoped()
        const handle = new ToolHandle(
          {
            name: "count",
            description: "Count",
            capabilities: [],
            inputSchema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
            outputSchema: { type: "number" },
          },
          (value) => Effect.succeed(Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(value).count + 1),
        )
        const input = {
          root: worktree.path,
          description: "External task",
          message: "Compute",
          input: { count: 7, token: "private-token" },
          tools: [handle],
          outputSchema: {
            type: "object",
            properties: { count: { type: "number" }, token: { type: "string" } },
            required: ["count", "token"],
          },
        }
        const call = (input: unknown) =>
          executeTool(env.tools, {
            sessionID: env.parent.id,
            ...toolIdentity,
            call: { type: "tool-call", id: crypto.randomUUID(), name: provider, input },
          })
        const result = yield* call(input)
        expect(result.status).toBe("completed")
        const child = output(result.output)
        expect(child).toMatchObject({
          status: "completed",
          message: "done",
          output: { count: 8, token: "private-token" },
        })
        expect(JSON.stringify(result.content)).not.toContain("private-token")
        expect(yield* env.sessions.get(child.sessionID)).toMatchObject({
          parentID: env.parent.id,
          location: { directory: worktree.path },
        })
        const record = yield* env.external.get(child.sessionID)
        expect(record).toMatchObject({ provider, directory: worktree.path, status: "completed", checkpoint: "1" })
        expect(JSON.stringify(yield* env.sessions.messages({ sessionID: child.sessionID }))).not.toContain(
          "private-token",
        )
        expect(runs.at(-1)?.message).not.toContain("private-token")
        yield* call({ ...input, sessionID: child.sessionID, model: "fixture-override", effort: "high" })
        expect((yield* env.sessions.get(child.sessionID)).model).toMatchObject({
          id: "fixture-override",
          variant: "high",
        })
        expect(runs.at(-1)).toMatchObject({ model: "fixture-override", effort: "high" })
        expect(yield* env.external.get(child.sessionID)).toMatchObject({
          vendorSessionID: record?.vendorSessionID,
          checkpoint: "2",
        })
        vendor.delete(record!.vendorSessionID!)
        yield* call({ ...input, sessionID: child.sessionID })
        expect((yield* env.external.get(child.sessionID))?.vendorSessionID).not.toBe(record?.vendorSessionID)
        expect(runs.at(-1)?.history.length).toBeGreaterThan(0)
      }),
    )

  it.live("rejects foreign children, divergent histories and directory changes", () =>
    Effect.gen(function* () {
      const env = yield* setup
      const input = { root: env.directory.path, description: "Task", message: "hello" }
      const call = (value: unknown) =>
        executeTool(env.tools, {
          sessionID: env.parent.id,
          ...toolIdentity,
          call: { type: "tool-call", id: crypto.randomUUID(), name: "codex", input: value },
        })
      const first = output((yield* call(input)).output)
      const record = yield* env.external.get(first.sessionID)
      vendor.set(record!.vendorSessionID!, 99)
      const before = yield* env.sessions.messages({ sessionID: first.sessionID })
      expect((yield* call({ ...input, sessionID: first.sessionID })).status).toBe("error")
      expect(yield* env.sessions.messages({ sessionID: first.sessionID })).toEqual(before)
      vendor.set(record!.vendorSessionID!, 1)
      expect((yield* call({ ...input, sessionID: first.sessionID })).status).toBe("completed")
      expect((yield* call({ ...input, sessionID: env.parent.id })).status).toBe("error")
      expect((yield* call({ ...input, sessionID: first.sessionID, root: "/tmp" })).status).toBe("error")
      expect((yield* call({ ...input, root: "relative" })).status).toBe("error")
      expect((yield* call({ ...input, root: env.directory.path + "/missing" })).status).toBe("error")
    }),
  )

  it.live("projects failures, preserves durable identity and never invokes the native model runner", () =>
    Effect.gen(function* () {
      const env = yield* setup
      const before = runs.length
      const result = yield* executeTool(env.tools, {
        sessionID: env.parent.id,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "failure",
          name: "pi",
          input: { root: env.directory.path, description: "Fail", message: "fail" },
        },
      })
      expect(result.status).toBe("error")
      const db = yield* Database.Service
      const rows = yield* db.db.select().from(ExternalSessionTable).where(eq(ExternalSessionTable.provider, "pi")).all()
      expect(rows).toHaveLength(1)
      expect(rows[0].status).toBe("failed")
      expect(runs.length).toBe(before + 1)
      expect(yield* env.sessions.get(rows[0].session_id)).toMatchObject({ outcome: "failed" })
    }),
  )

  it.live("does not repeat readiness probes when model snapshots are taken", () =>
    Effect.gen(function* () {
      const env = yield* setup
      const count = checks.length
      for (let i = 0; i < 5; i++)
        expect((yield* env.tools.snapshot()).definitions.map((tool) => tool.name)).toEqual(
          expect.arrayContaining(["claude", "codex", "pi"]),
        )
      expect(checks.length).toBe(count)
    }),
  )
  it.live("interruption settles the child and closes its machine activation before returning", () =>
    Effect.gen(function* () {
      const env = yield* setup
      const count = runs.length
      const fiber = yield* executeTool(env.tools, {
        sessionID: env.parent.id,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "wait",
          name: "pi",
          input: { root: env.directory.path, description: "Wait", message: "wait" },
        },
      }).pipe(Effect.forkChild)
      while (runs.length === count) yield* Effect.yieldNow
      const gateway = runs.at(-1)!.gateway
      yield* Fiber.interrupt(fiber)
      const database = yield* Database.Service
      const rows = yield* database.db.select().from(ExternalSessionTable).all()
      expect(rows).toHaveLength(1)
      const execution = yield* SessionExecution.Service
      yield* execution.awaitIdle(rows[0].session_id)
      expect((yield* env.external.get(rows[0].session_id))?.status).toBe("interrupted")
      expect((yield* Effect.result(gateway.invoke("execute", { code: "1" })))._tag).toBe("Failure")
      const continued = yield* executeTool(env.tools, {
        sessionID: env.parent.id,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "continue",
          name: "pi",
          input: {
            root: env.directory.path,
            description: "Continue",
            message: "hello",
            sessionID: rows[0].session_id,
          },
        },
      })
      expect(continued.status).toBe("completed")
    }),
  )

  it.live("external records follow ordinary lifecycle events and disappear with the child", () =>
    Effect.gen(function* () {
      const env = yield* setup
      const bus = yield* Bus.Service
      const child = yield* env.sessions.create({ parentID: env.parent.id })
      yield* bus.publish(ExternalSession.Bound, {
        sessionID: child.id,
        provider: "claude",
        directory: child.location.directory,
      })
      yield* bus.publish(ExternalSession.Linked, { sessionID: child.id, vendorSessionID: "original" })
      yield* bus.publish(ExternalSession.Checkpointed, {
        sessionID: child.id,
        checkpoint: "vendor",
        historyHash: "canonical",
      })
      expect(yield* env.external.get(child.id)).toMatchObject({
        status: "idle",
        checkpoint: "vendor",
        historyHash: "canonical",
      })
      yield* bus.publish(SessionEvent.Execution.Started, { sessionID: child.id })
      expect((yield* env.external.get(child.id))?.status).toBe("running")
      yield* bus.publish(SessionEvent.Execution.Interrupted, { sessionID: child.id, reason: "user" })
      expect((yield* env.external.get(child.id))?.status).toBe("interrupted")
      yield* bus.publish(ExternalSession.Linked, { sessionID: child.id, vendorSessionID: "replacement" })
      expect(yield* env.external.get(child.id)).toMatchObject({
        vendorSessionID: "replacement",
        checkpoint: undefined,
        historyHash: undefined,
      })
      const journal = yield* Stream.runCollect(bus.log({ aggregateID: child.id }))
      const expected = yield* env.external.get(child.id)
      yield* env.sessions.remove(child.id)
      expect(yield* env.external.get(child.id)).toBeUndefined()
      for (const event of journal) {
        if (Bus.isSynced(event) || event.durable === undefined) continue
        yield* bus.replay({
          id: event.id,
          created: event.created,
          type: Bus.versionedType(event.type, event.durable.version),
          seq: event.durable.seq,
          aggregateID: child.id,
          data: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(event.data),
        })
      }
      expect(yield* env.external.get(child.id)).toEqual(expected)
    }),
  )

  for (const provider of ExternalSession.Provider.literals)
    it.live(`${provider}: native SDK tools cannot bypass an OC++ edit denial`, () =>
      Effect.gen(function* () {
        const env = yield* setup
        yield* env.agents.transform((draft) =>
          draft.update(toolIdentity.agent, (agent) => {
            agent.permissions.push({ action: "edit", resource: "file", effect: "deny" })
          }),
        )
        const snapshot = yield* env.tools.snapshot()
        const result = yield* Effect.result(
          snapshot.execute({
            sessionID: env.parent.id,
            ...toolIdentity,
            call: {
              type: "tool-call",
              id: "deny",
              name: provider,
              input: { root: env.directory.path, description: "Denied edit", message: "native" },
            },
          }),
        )
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") expect(result.failure.metadata).toHaveProperty("sessionID")
      }),
    )
  it.live("native files outside the approved root require another directory permission", () =>
    Effect.gen(function* () {
      const env = yield* setup
      const outside = yield* tmpdirScoped()
      yield* env.agents.transform((draft) =>
        draft.update(toolIdentity.agent, (agent) => {
          agent.permissions.push({ action: "external_directory", resource: outside.path + "/*", effect: "deny" })
        }),
      )
      const result = yield* executeTool(env.tools, {
        sessionID: env.parent.id,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "outside",
          name: "claude",
          input: {
            root: env.directory.path,
            description: "Outside",
            message: "outside:" + outside.path + "/file",
          },
        },
      })
      expect(result.status).toBe("error")
    }),
  )

  for (const provider of ["claude", "pi"])
    it.live(`${provider}: compound shell commands retain individual command restrictions`, () =>
      Effect.gen(function* () {
        const env = yield* setup
        yield* env.agents.transform((draft) =>
          draft.update(toolIdentity.agent, (agent) => {
            agent.permissions.push({ action: "shell", resource: "rm *", effect: "deny" })
          }),
        )
        const result = yield* executeTool(env.tools, {
          sessionID: env.parent.id,
          ...toolIdentity,
          call: {
            type: "tool-call",
            id: "shell",
            name: provider,
            input: { root: env.directory.path, description: "Shell", message: "shell" },
          },
        })
        expect(result.status).toBe("error")
      }),
    )

  it.live("unknown SDK diagnostics stay bounded and never enter canonical child history", () =>
    Effect.gen(function* () {
      const env = yield* setup
      const child = yield* env.sessions.create({ parentID: env.parent.id })
      const bus = yield* Bus.Service
      const stream = ExternalAgentStream.make(bus, child.id, toolIdentity.agent, {
        providerID: Provider.ID.make("claude"),
        id: Model.ID.make("sonnet"),
      })
      for (let index = 0; index < 100; index++)
        yield* stream.emit({ type: "diagnostic", name: "unknown:" + index + "x".repeat(110) })
      expect(Object.keys(stream.diagnostics())).toHaveLength(32)
      expect(Object.keys(stream.diagnostics()).every((name) => name.length <= 100)).toBe(true)
      expect(yield* env.sessions.messages({ sessionID: child.id })).toHaveLength(0)
      yield* stream.emit({ type: "text", id: "answer", delta: "Known response" })
      yield* stream.finish()
      expect(JSON.stringify(yield* env.sessions.messages({ sessionID: child.id }))).not.toContain("unknown:")
    }),
  )
})
