import { describe, expect } from "bun:test"
import { Agent } from "@ocpp/core/agent"
import { Bus } from "@ocpp/core/bus"
import { Database } from "@ocpp/core/database/database"
import { CodeModeStore } from "@ocpp/core/codemode/store"
import { CodeModeExecutionTable } from "@ocpp/core/codemode/sql"
import type { Permission } from "@ocpp/core/permission"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { Image } from "@ocpp/core/image"
import { Job } from "@ocpp/core/job"
import { PluginHooks } from "@ocpp/core/plugin/hooks"
import { PluginRuntime } from "@ocpp/core/plugin/runtime"
import { Session } from "@ocpp/core/session"
import { SessionEvent } from "@ocpp/core/session/event"
import { SessionMessage } from "@ocpp/core/session/message"
import { SessionModelRequest } from "@ocpp/core/session/model-request"
import { SessionRunnerModel } from "@ocpp/core/session/runner/model"
import { CodeModeExecution } from "@ocpp/schema/codemode-execution"
import { LanguageModel } from "@ocpp/ai"
import { route } from "@ocpp/ai/protocols/openai-chat"
import { State } from "@ocpp/core/state"
import { Tool } from "@ocpp/core/tool"
import type { Info } from "@ocpp/schema/tool"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import {
  codeModeTools,
  executeTool,
  readCodeModeNotebook,
  readCodeModeOutcome,
  seedToolSession,
  toolDefinitions,
} from "./lib/tool"
import { Deferred, Effect, Exit, Fiber, Layer, Logger, Schema, SchemaGetter, SchemaIssue, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { z } from "zod"
import { testEffect } from "./lib/effect"

const imageStore = Layer.mock(Image.Service, {
  normalize: (resource, content) => {
    if (resource === "corrupt.png") return Effect.fail(new Image.DecodeError({ resource }))
    if (resource === "too-large.png")
      return Effect.fail(
        new Image.SizeError({
          resource,
          width: 9_000,
          height: 9_000,
          bytes: content.content.length,
          maxWidth: 2_000,
          maxHeight: 2_000,
          maxBytes: 5,
        }),
      )
    return Effect.succeed({
      ...content,
      content: Buffer.from(`${Buffer.from(content.content, "base64").toString()} normalized`).toString("base64"),
      mime: "image/jpeg",
    })
  },
})
/** Completion notifications, recorded before delivery parks so tests can read what the model would see. */
const deliveries: Array<{ text: string; files?: ReadonlyArray<unknown>; metadata?: Record<string, unknown> }> = []
let testJobs: Job.Interface | undefined
const jobLayer = AppNodeBuilder.build(LayerNode.group([Job.node]))
const runtimeLayer = Layer.unwrap(
  Effect.gen(function* () {
    const jobs = yield* Job.Service
    testJobs = jobs
    return Layer.mock(PluginRuntime.Service, {
      job: {
        start: jobs.start,
        startLimited: jobs.startLimited,
        active: jobs.active,
        wait: jobs.wait,
        block: jobs.block,
        background: jobs.background,
        cancel: jobs.cancel,
        cancelAll: jobs.cancelAll,
        markBackgroundTerminal: jobs.markBackgroundTerminal,
        completeBackground: jobs.completeBackground,
      },
      session: {
        get: () => Effect.die("Unavailable in Tool registry tests"),
        create: () => Effect.die("Unavailable in Tool registry tests"),
        messages: () => Effect.die("Unavailable in Tool registry tests"),
        message: () => Effect.succeed(undefined),
        prompt: () => Effect.die("Unavailable in Tool registry tests"),
        generate: () => Effect.die("Unavailable in Tool registry tests"),
        command: () => Effect.die("Unavailable in Tool registry tests"),
        rename: () => Effect.die("Unavailable in Tool registry tests"),
        move: () => Effect.die("Unavailable in Tool registry tests"),
        resume: () => Effect.die("Unavailable in Tool registry tests"),
        switchAgent: () => Effect.die("Unavailable in Tool registry tests"),
        switchModel: () => Effect.die("Unavailable in Tool registry tests"),
        interrupt: () => Effect.die("Unavailable in Tool registry tests"),
        synthetic: (input) => Effect.sync(() => void deliveries.push(input)).pipe(Effect.andThen(Effect.never)),
        wait: () => Effect.die("Unavailable in Tool registry tests"),
        context: () => Effect.die("Unavailable in Tool registry tests"),
      },
      persistentPty: { read: () => Effect.die("Unavailable in Tool registry tests") },
      location: {
        agent: { list: () => Effect.die("Unavailable in Tool registry tests") },
        mcp: { list: () => Effect.die("Unavailable in Tool registry tests") },
      },
    })
  }),
).pipe(Layer.provide(jobLayer))
const registryLayer = AppNodeBuilder.build(
  LayerNode.group([Tool.node, PluginHooks.node, SessionModelRequest.node, Bus.node, Database.node, CodeModeStore.node]),
  [
    [Image.node, imageStore],
    [PluginRuntime.node, runtimeLayer],
  ],
)
const it = testEffect(registryLayer)
const identity = {
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_registry"),
}
const sessionID = Session.ID.make("ses_registry")
const call = (name: string, id = `call-${name}`): Parameters<Tool.Snapshot["execute"]>[0] => ({
  sessionID,
  ...identity,
  call: { type: "tool-call", id, name, input: { text: name } },
})

const CodeModeOutput = Schema.Struct({ executionID: CodeModeExecution.ID, status: Schema.Literal("running") })
const isCodeModeStarted = (event: Bus.LogItem): event is SessionEvent.CodeMode.Started =>
  event.type === SessionEvent.CodeMode.Started.type
const waitCodeMode = (output: unknown, id: string) =>
  Effect.gen(function* () {
    const jobs = testJobs
    if (!jobs) return yield* Effect.die("Job test service is unavailable")
    const value = Schema.decodeUnknownSync(CodeModeOutput)(output)
    expect(value.executionID).toStartWith("exe_")
    expect((yield* jobs.get(value.executionID))?.status).toBe("running")
    const bus = yield* Bus.Service
    yield* bus.publish(SessionEvent.Tool.Success, {
      sessionID,
      assistantMessageID: identity.messageID,
      id,
      content: [{ type: "text", text: "Execution started" }],
      executed: false,
    })
    const info = (yield* jobs.wait({ id: value.executionID })).info
    return { ...(yield* readCodeModeOutcome(value.executionID)), summary: info?.output ?? info?.error ?? "" }
  })

/** Runs a program through a snapshot's `execute`, the only tool the model is offered, and waits for it to settle. */
const run = (snapshot: Tool.Snapshot, id: string, code: string) =>
  snapshot
    .execute({ ...call("execute", id), call: { type: "tool-call", id, name: "execute", input: { code } } })
    .pipe(Effect.flatMap((result) => waitCodeMode(result.output, id)))

const deliveredFor = (executionID: string, remaining = 1000): Effect.Effect<(typeof deliveries)[number]> =>
  Effect.gen(function* () {
    const found = deliveries.find((item) => item.metadata?.executionID === executionID)
    if (found) return found
    if (remaining === 0) return yield* Effect.die(`No completion was delivered for ${executionID}`)
    yield* Effect.promise(() => Bun.sleep(1))
    return yield* deliveredFor(executionID, remaining - 1)
  })

const png = (name: string, text = "image") => ({
  type: "file" as const,
  uri: `data:image/png;base64,${Buffer.from(text).toString("base64")}`,
  mime: "image/png",
  name,
})

const make = (): Info => ({
  name: "echo",
  description: "Echo text",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  execute: ({ text }) => Effect.succeed({ output: { text }, content: text }),
})

const constant = (text: string): Info => ({
  name: "constant",
  description: "Return text",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  execute: () => Effect.succeed({ output: { text }, content: text }),
})

const transform = (service: Tool.Interface, tools: Readonly<Record<string, Info>>, options?: Tool.Options) =>
  service.transform((draft) =>
    Object.entries(tools).forEach(([name, tool]) => draft.add({ ...tool, name, options: options ?? tool.options })),
  )

describe("Tool", () => {
  it.effect("reads the current draft tools by effective name", () =>
    Effect.gen(function* () {
      yield* seedToolSession(sessionID, identity.messageID)
      const service = yield* Tool.Service
      yield* transform(service, { echo: make() }, { namespace: "acme" })
      yield* service.transform((draft) => {
        expect(draft.list().map((tool) => tool.id)).toEqual(["acme_echo"])
        expect(draft.get("acme_echo")?.id).toBe("acme_echo")
        expect(draft.get("acme_echo")?.name).toBe("echo")
        expect(draft.get("missing")).toBeUndefined()
      })
    }),
  )

  it.effect("isolates temporary tools to one Session and restores earlier registrations", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, { echo: constant("base") })
      const other = Session.ID.make("ses_registry_other")
      const first = yield* service.registerSession(sessionID, [
        { ...constant("session"), name: "echo" },
        { ...constant("temporary"), name: "temporary" },
      ])

      expect((yield* service.snapshot(undefined, other)).codeModeCatalog?.map((tool) => tool.path)).toEqual(["echo"])
      expect((yield* service.snapshot(undefined, sessionID)).codeModeCatalog?.map((tool) => tool.path)).toEqual([
        "echo",
        "temporary",
      ])
      expect((yield* executeTool(service, call("echo"))).output).toEqual({ text: "session" })
      expect((yield* executeTool(service, { ...call("echo"), sessionID: other })).output).toEqual({ text: "base" })

      yield* first.dispose
      expect((yield* service.snapshot(undefined, sessionID)).codeModeCatalog?.map((tool) => tool.path)).toEqual([
        "echo",
      ])
      expect((yield* service.registrations(undefined, sessionID)).map((tool) => tool.name)).toEqual(["echo"])
    }),
  )

  it.effect("refuses a second machine-input registration for one Session", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const first = yield* service.registerSession(sessionID, [{ ...constant("first"), name: "temporary_one" }], {
        input: { dataset: [1] },
      })
      // A concurrent second input-bearing registration would silently cross-wire which value the
      // child reads as `input`, so it is refused with a typed error rather than accepted.
      const error = yield* service
        .registerSession(sessionID, [{ ...constant("second"), name: "temporary_two" }], { input: { dataset: [2] } })
        .pipe(Effect.flip)
      expect(error).toBeInstanceOf(Tool.RegistrationError)
      expect(error.message).toContain("Machine input is already registered")
      // The refused registration left nothing behind, and an input-free registration is still allowed.
      expect((yield* service.registrations(undefined, sessionID)).map((tool) => tool.name)).toEqual(["temporary_one"])
      const third = yield* service.registerSession(sessionID, [{ ...constant("third"), name: "temporary_three" }])
      yield* first.dispose
      // The first input registration is gone, so a fresh input registration is accepted again.
      const fourth = yield* service.registerSession(sessionID, [{ ...constant("fourth"), name: "temporary_four" }], {
        input: { dataset: [4] },
      })
      yield* third.dispose
      yield* fourth.dispose
    }),
  )

  it.effect("repairs names and inputs before lookup using the captured request tool set", () =>
    Effect.gen(function* () {
      yield* seedToolSession(sessionID, identity.messageID)
      const service = yield* Tool.Service
      const hooks = yield* PluginHooks.Service
      yield* transform(service, { echo: constant("captured") })
      const snapshot = yield* service.snapshot()
      const modelRequests = yield* SessionModelRequest.Service
      yield* hooks.register("session", "context", (event) =>
        Effect.sync(() => {
          const execute = event.tools.execute
          if (!execute) throw new Error("Expected execute definition")
          event.tools.alias = execute
          delete event.tools.execute
        }),
      )
      const prepared = yield* modelRequests.prepare({
        scope: {
          session: Schema.decodeUnknownSync(Session.Info)({
            id: sessionID,
            projectID: "project",
            location: { directory: "/test" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: 0, updated: 0 },
          }),
          agentID: identity.agent,
          model: SessionRunnerModel.resolved(LanguageModel.make({ id: "test", provider: "test", route }), {
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            cost: [],
            limit: { context: 200_000, output: 32_000 },
          }),
          tools: snapshot,
        },
        transcript: { system: [], messages: [] },
      })
      expect(prepared.request.tools.map((tool) => tool.name)).toEqual(["alias"])
      yield* transform(service, { echo: constant("new") })
      const before: string[] = []
      const after: string[] = []
      yield* hooks.register("tool", "execute.before", (event) =>
        Effect.sync(() => {
          expect(event).not.toHaveProperty("inputSchema")
          before.push(event.tool)
          if (event.tool !== "typo") return
          event.tool = "alias"
          event.input = { code: 'return tools.echo({ text: "corrected" })' }
        }),
      )
      yield* hooks.register("tool", "execute.after", (event) =>
        Effect.sync(() => {
          after.push(event.tool)
        }),
      )
      const repaired = yield* prepared.executeTool(call("typo"))
      expect(yield* waitCodeMode(repaired.output, "call-typo")).toMatchObject({
        status: "saved",
        summary: expect.stringContaining('{"text":"captured"}'),
      })
      expect(before).toEqual(["typo", "echo"])
      expect(after).toEqual(["execute", "echo"])
      expect(yield* prepared.executeTool(call("execute")).pipe(Effect.flip)).toMatchObject({
        message: "Tool is not available for this request: execute",
      })
      expect(yield* prepared.executeTool(call("missing")).pipe(Effect.flip)).toMatchObject({
        message: "Unknown tool: missing",
      })
      expect(before).toEqual(["typo", "echo", "execute", "missing"])
      expect(after).toEqual(["execute", "echo"])
    }),
  )

  it.effect("hooks execute and known Code Mode calls once but leaves unknown interpreter paths unchanged", () =>
    Effect.gen(function* () {
      yield* seedToolSession(sessionID, identity.messageID)
      const service = yield* Tool.Service
      const hooks = yield* PluginHooks.Service
      yield* transform(service, { echo: make() })
      const seen: string[] = []
      yield* hooks.register("tool", "execute.before", (event) =>
        Effect.sync(() => {
          seen.push(event.tool)
          expect(event).not.toHaveProperty("inputSchema")
          if (event.tool === "run_code") event.tool = "execute"
        }),
      )
      const snapshot = yield* service.snapshot()
      const known = yield* snapshot.execute({
        ...call("run_code"),
        call: {
          type: "tool-call",
          id: "known",
          name: "run_code",
          input: { code: 'return tools.echo({ text: "hello" })' },
        },
      })
      expect(yield* waitCodeMode(known.output, "known")).toMatchObject({
        status: "saved",
        summary: expect.stringContaining('{"text":"hello"}'),
      })
      expect(seen).toEqual(["run_code", "echo"])
      // An unknown path is refused when the program compiles, so no hook ever sees it.
      const unknown = yield* snapshot
        .execute({
          ...call("execute"),
          call: {
            type: "tool-call",
            id: "unknown",
            name: "execute",
            input: { code: "return tools.missing({})" },
          },
        })
        .pipe(Effect.flip)
      expect(unknown.metadata).toMatchObject({ executionStatus: "refused", kind: "UnknownTool", tools: ["missing"] })
      expect(seen).toEqual(["run_code", "echo", "execute"])
    }),
  )

  it.effect("replays mutations on refreshed sources and restores tools on disposal and scope cleanup", () =>
    Effect.gen(function* () {
      yield* seedToolSession(sessionID, identity.messageID)
      const service = yield* Tool.Service
      let text = "original"
      const source = yield* Scope.make()
      yield* service
        .transform((draft) => {
          draft.add({ ...constant(text), name: "echo", options: { namespace: "acme" } })
          draft.add({ ...make(), name: "hidden" })
        })
        .pipe(Scope.provide(source))
      const original = yield* service.snapshot()
      const update = yield* service.transform((draft) => {
        draft.update("missing", () => {
          throw new Error("must not create a tool")
        })
        draft.remove("missing")
        draft.update("acme_echo", (tool) => {
          const execute = tool.execute
          tool.description = "Updated"
          tool.execute = (input, context) =>
            execute(input, context).pipe(
              Effect.map((result) => ({ ...result, output: { text: `${result.output.text} updated` } })),
            )
        })
      })
      const scope = yield* Scope.make()
      yield* service.transform((draft) => draft.remove("hidden")).pipe(Scope.provide(scope))
      expect(yield* codeModeTools(service)).toEqual(["acme.echo"])
      expect((yield* executeTool(service, call("acme_echo"))).output).toEqual({ text: "original updated" })

      text = "refreshed"
      const reload = yield* service.reload().pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("500 millis")
      yield* Fiber.join(reload)
      const refreshed = yield* service.snapshot()
      expect(refreshed.codeModeCatalog).toEqual([
        expect.objectContaining({ path: "acme.echo", description: "Updated" }),
      ])
      const echo = 'return tools.acme.echo({ text: "echo" })'
      expect(yield* run(refreshed, "call-refreshed", echo)).toMatchObject({
        summary: expect.stringContaining('{"text":"refreshed updated"}'),
      })
      expect(yield* run(original, "call-original", echo)).toMatchObject({
        summary: expect.stringContaining('{"text":"original"}'),
      })

      yield* update.dispose
      yield* update.dispose
      expect((yield* executeTool(service, call("acme_echo"))).output).toEqual({ text: "refreshed" })
      yield* Scope.close(scope, Exit.void)
      expect(yield* codeModeTools(service)).toEqual(["acme.echo", "hidden"])

      yield* service.transform((draft) =>
        draft.update("acme_echo", (tool) => {
          tool.description = "Updated again"
        }),
      )
      yield* Scope.close(source, Exit.void)
      expect(yield* toolDefinitions(service)).toEqual([])
    }),
  )

  it.effect("updates schemas and executors without renaming tools and applies removal in order", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((draft) => {
        draft.add({ ...make(), options: { namespace: "acme.tools" } })
        draft.add({ ...make(), name: "removed" })
        draft.remove("removed")
        draft.update("removed", () => {
          throw new Error("must not resurrect a tool")
        })
        draft.remove("acme_tools_echo")
        draft.add({ ...make(), options: { namespace: "acme.tools" } })
        draft.update("acme_tools_echo", (tool) => {
          tool.name = "renamed"
          tool.options = { namespace: "other" }
          tool.input = Schema.Struct({ value: Schema.Finite })
          tool.output = Schema.Finite
          tool.execute = ({ value }) => Effect.succeed({ output: value + 1 })
        })
      })
      expect(yield* codeModeTools(service)).toEqual(["acme.tools.echo"])
      expect((yield* service.snapshot()).codeModeCatalog?.[0]?.signature).toContain("value")
      expect(
        (yield* executeTool(service, {
          ...call("acme_tools_echo"),
          call: { type: "tool-call", id: "updated", name: "acme_tools_echo", input: { value: 2 } },
        })).output,
      ).toBe(3)
      expect(yield* executeTool(service, call("acme_tools_echo"))).toMatchObject({ status: "error" })
    }),
  )

  it.effect("skips invalid updates without dropping the existing definition", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, { echo: make() })
      yield* service.transform((draft) =>
        draft.update("echo", (tool) => {
          Object.assign(tool, { description: undefined })
        }),
      )
      expect((yield* service.snapshot()).codeModeCatalog?.[0]?.description).toBe("Echo text")
      expect((yield* executeTool(service, call("echo"))).output).toEqual({ text: "echo" })
    }),
  )

  it.effect("replays empty sources on reload and keeps advertised snapshots", () =>
    Effect.gen(function* () {
      yield* seedToolSession(sessionID, identity.messageID)
      const service = yield* Tool.Service
      let source: Info[] = []
      yield* service.transform((draft) => source.forEach((tool) => draft.add(tool)))
      expect(yield* toolDefinitions(service)).toEqual([])

      const tool = { ...constant("first"), name: "echo" }
      source = [tool]
      const first = yield* service.reload().pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("500 millis")
      yield* Fiber.join(first)
      const advertised = yield* service.snapshot()
      const echo = 'return tools.echo({ text: "echo" })'
      const fromAdvertised = { summary: expect.stringContaining('{"text":"first"}') }
      expect(yield* run(advertised, "call-advertised-1", echo)).toMatchObject(fromAdvertised)

      tool.execute = constant("second").execute
      expect(yield* run(advertised, "call-advertised-2", echo)).toMatchObject(fromAdvertised)
      const second = yield* service.reload().pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("500 millis")
      yield* Fiber.join(second)
      expect((yield* executeTool(service, call("echo"))).output).toEqual({ text: "second" })
      expect(yield* run(advertised, "call-advertised-3", echo)).toMatchObject(fromAdvertised)

      source = []
      const removed = yield* service.reload().pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("500 millis")
      yield* Fiber.join(removed)
      expect(yield* toolDefinitions(service)).toEqual([])
      expect(yield* run(advertised, "call-advertised-4", echo)).toMatchObject(fromAdvertised)
    }),
  )

  it.effect("disposes overlays once and replays remaining transforms in order", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const runs: string[] = []
      yield* service.transform((draft) => {
        runs.push("base")
        draft.add({ ...constant("base"), name: "echo" })
      })
      const scope = yield* Scope.make()
      const overlay = yield* service
        .transform((draft) => {
          runs.push("overlay")
          draft.add({ ...constant("overlay"), name: "echo" })
        })
        .pipe(Scope.provide(scope))
      expect(runs).toEqual(["base", "base", "overlay"])
      expect((yield* executeTool(service, call("echo"))).output).toEqual({ text: "overlay" })

      yield* overlay.dispose
      expect(runs).toEqual(["base", "base", "overlay", "base"])
      expect((yield* executeTool(service, call("echo"))).output).toEqual({ text: "base" })
      yield* overlay.dispose
      yield* Scope.close(scope, Exit.void)
      expect(runs).toEqual(["base", "base", "overlay", "base"])
    }),
  )

  it.effect("batches tool publication and suppresses terminal teardown replay", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const runs: string[] = []
      const scope = yield* Scope.make()
      yield* State.batch(
        Effect.gen(function* () {
          yield* service.transform((draft) => {
            runs.push("base")
            draft.add({ ...constant("base"), name: "echo" })
          })
          yield* service.transform((draft) => {
            runs.push("overlay")
            draft.add({ ...constant("overlay"), name: "echo" })
          })
          expect(runs).toEqual([])
          expect(yield* toolDefinitions(service)).toEqual([])
        }).pipe(Scope.provide(scope)),
      )

      expect(runs).toEqual(["base", "overlay"])
      expect((yield* executeTool(service, call("echo"))).output).toEqual({ text: "overlay" })
      yield* State.batch(Scope.close(scope, Exit.void), { flush: false })
      expect(runs).toEqual(["base", "overlay"])
    }),
  )

  it.effect("uses the last valid addition on replay and restores earlier transforms on disposal", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, { echo_tool: constant("base") })
      let source = [{ ...constant("overlay"), name: "echo.tool" }]
      const registration = yield* service.transform((draft) => source.forEach((tool) => draft.add(tool)))
      expect((yield* executeTool(service, call("echo_tool"))).output).toEqual({ text: "overlay" })

      source = [...source, { ...constant("collision"), name: "echo_tool" }]
      const collision = yield* service.reload().pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("500 millis")
      yield* Fiber.join(collision)
      expect((yield* executeTool(service, call("echo_tool"))).output).toEqual({ text: "collision" })

      yield* registration.dispose
      expect((yield* executeTool(service, call("echo_tool"))).output).toEqual({ text: "base" })
      yield* service.transform((draft) => source.forEach((tool) => draft.add(tool)))

      source = [{ ...constant("invalid"), name: "" }]
      const invalid = yield* service.reload().pipe(Effect.forkChild({ startImmediately: true }))
      yield* TestClock.adjust("500 millis")
      yield* Fiber.join(invalid)
      expect((yield* executeTool(service, call("echo_tool"))).output).toEqual({ text: "base" })
    }),
  )

  it.effect("logs and skips invalid dotted namespaces", () => {
    const output: unknown[] = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      output.push(entry.message)
    })
    return Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, { echo: make() }, { namespace: "slack..admin" })

      expect(output).toEqual([
        [
          "Skipping invalid tool registration",
          { name: "echo", namespace: "slack..admin", error: 'Invalid tool namespace: "slack..admin"' },
        ],
      ])
      const snapshot = yield* service.snapshot()
      expect(snapshot.definitions).toEqual([])
      expect(snapshot.codeModeCatalog).toBeUndefined()
    }).pipe(Effect.provide(Logger.layer([logger])))
  })

  it.effect("skips invalid and reserved names while letting the last normalized name win", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, {
        before: make(),
        "": make(),
        ["x".repeat(65)]: make(),
        "echo.tool": constant("first"),
        echo_tool: constant("last"),
        search: make(),
        after: make(),
      })
      const snapshot = yield* service.snapshot()
      expect(snapshot.definitions.map((tool) => tool.name)).toEqual(["execute"])
      expect(snapshot.codeModeCatalog?.map((tool) => tool.path)).toEqual(["after", "before", "echo_tool"])
      expect((yield* executeTool(service, call("before"))).output).toEqual({ text: "before" })
      expect((yield* executeTool(service, call("after"))).output).toEqual({ text: "after" })
      expect((yield* executeTool(service, call("echo_tool"))).output).toEqual({ text: "last" })
    }),
  )

  it.effect("reserves the built-in Code Mode search path", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, { search: make() })

      const snapshot = yield* service.snapshot()
      expect(snapshot.definitions).toEqual([])
      expect(snapshot.codeModeCatalog).toBeUndefined()
    }),
  )

  it.effect("executes Code Mode tools without requiring letter-leading names or namespace segments", () =>
    Effect.gen(function* () {
      yield* seedToolSession(sessionID, identity.messageID)
      const service = yield* Tool.Service
      yield* transform(service, { "2d_get_scene": make(), "123": make(), _lookup: make(), "-lookup": make() })
      yield* transform(service, { "2d_get_scene": make() }, { namespace: "123._private.-tools" })

      const snapshot = yield* service.snapshot()
      expect(snapshot.definitions.map((tool) => tool.name)).toEqual(["execute"])
      expect(snapshot.codeModeCatalog?.map((tool) => tool.path)).toEqual([
        "-lookup",
        "123",
        "123._private.-tools.2d_get_scene",
        "2d_get_scene",
        "_lookup",
      ])
      const result = yield* snapshot.execute({
        ...call("execute"),
        call: {
          type: "tool-call",
          id: "call-nonletter-names",
          name: "execute",
          input: {
            code: `const results = [
              tools["2d_get_scene"]({ text: "digit" }),
              tools["123"]({ text: "numeric" }),
              tools._lookup({ text: "underscore" }),
              tools["-lookup"]({ text: "hyphen" }),
              tools["123"]._private["-tools"]["2d_get_scene"]({ text: "namespaced" }),
            ]
            const joined = results.map(result => result.text).join(",")`,
          },
        },
      })
      expect(yield* waitCodeMode(result.output, "call-nonletter-names")).toMatchObject({
        status: "saved",
        saved: ["results", "joined"],
      })
      expect(yield* readCodeModeNotebook(sessionID)).toMatchObject({
        joined: "digit,numeric,underscore,hyphen,namespaced",
      })
    }),
  )

  it.effect("does not impose a wall-clock deadline on Code Mode executions", () =>
    Effect.gen(function* () {
      yield* seedToolSession(sessionID, identity.messageID)
      const started = yield* Deferred.make<void>()
      const service = yield* Tool.Service
      yield* transform(service, {
        delayed: {
          name: "delayed",
          description: "Return after a delay",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.sleep("121 seconds")),
              Effect.as({ output: "finished", content: "finished" }),
            ),
        },
      })

      const snapshot = yield* service.snapshot()
      const result = yield* snapshot.execute({
        ...call("execute", "no-deadline"),
        call: {
          type: "tool-call",
          id: "no-deadline",
          name: "execute",
          input: { code: "const result = tools.delayed({})" },
        },
      })
      const waiting = yield* waitCodeMode(result.output, "no-deadline").pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* TestClock.adjust("121 seconds")

      expect(yield* Fiber.join(waiting)).toMatchObject({ status: "saved", saved: ["result"] })
      expect(yield* readCodeModeNotebook(sessionID)).toMatchObject({ result: "finished" })
    }),
  )

  it.effect("discards executions rejected by the concurrency limit", () =>
    Effect.gen(function* () {
      yield* seedToolSession(sessionID, identity.messageID)
      const service = yield* Tool.Service
      // `execute` is offered only while a tool is reachable.
      yield* transform(service, { echo: make() })
      const snapshot = yield* service.snapshot()
      const started = yield* Effect.forEach(
        Array.from({ length: 10 }, (_, index) => index),
        (index) =>
          snapshot.execute({
            ...call("execute", "detached-" + index),
            call: {
              type: "tool-call",
              id: "detached-" + index,
              name: "execute",
              input: { code: "return null" },
            },
          }),
      )
      const rejected = yield* snapshot
        .execute({
          ...call("execute", "detached-rejected"),
          call: {
            type: "tool-call",
            id: "detached-rejected",
            name: "execute",
            input: { code: "return null" },
          },
        })
        .pipe(Effect.flip)
      expect(rejected.message).toContain("At most 10 executions")

      const db = (yield* Database.Service).db
      expect((yield* db.select({ id: CodeModeExecutionTable.id }).from(CodeModeExecutionTable).all()).length).toBe(10)
      const jobs = testJobs ?? (yield* Effect.die("Job test service is unavailable"))
      yield* Effect.forEach(
        started,
        (item) => jobs.cancel(Schema.decodeUnknownSync(CodeModeOutput)(item.output).executionID),
        { discard: true },
      )
    }),
  )

  it.effect("cancels the job when launch is interrupted before listener registration", () =>
    Effect.gen(function* () {
      yield* seedToolSession(sessionID, identity.messageID)
      const service = yield* Tool.Service
      // `execute` is offered only while a tool is reachable.
      yield* transform(service, { echo: make() })
      const bus = yield* Bus.Service
      const started = yield* Deferred.make<CodeModeExecution.ID>()
      const block = yield* Deferred.make<void>()
      const unsubscribe = yield* bus.listen((event) => {
        if (!isCodeModeStarted(event) || event.data.id !== "detached-interrupted") return Effect.void
        return Deferred.succeed(started, event.data.executionID).pipe(Effect.andThen(Deferred.await(block)))
      })
      const snapshot = yield* service.snapshot()
      const fiber = yield* snapshot
        .execute({
          ...call("execute", "detached-interrupted"),
          call: {
            type: "tool-call",
            id: "detached-interrupted",
            name: "execute",
            input: { code: "return null" },
          },
        })
        .pipe(Effect.forkChild)
      const executionID = yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      yield* unsubscribe

      const jobs = testJobs ?? (yield* Effect.die("Job test service is unavailable"))
      expect((yield* jobs.get(executionID))?.status).toBe("cancelled")
      expect(yield* readCodeModeOutcome(executionID)).toMatchObject({
        status: "indeterminate",
        saved: [],
        error: expect.stringContaining("indeterminate"),
      })
    }),
  )

  it.effect("keeps healthy tools when another namespace is invalid", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((draft) => {
        draft.add({ ...make(), name: "first" })
        draft.add({ ...make(), name: "second", options: { namespace: "invalid..namespace" } })
        draft.add({ ...make(), name: "second", options: { namespace: "invalid__namespace" } })
      })

      const snapshot = yield* service.snapshot()
      expect(snapshot.definitions.map((tool) => tool.name)).toEqual(["execute"])
      expect(snapshot.codeModeCatalog?.map((tool) => tool.path)).toEqual(["first", "invalid__namespace.second"])
    }),
  )

  it.effect("logs invalid tool definitions without dropping healthy tools", () => {
    const output: unknown[] = []
    const logger = Logger.map(Logger.formatStructured, (entry) => {
      output.push(entry.message)
    })
    return Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((draft) => {
        draft.add({ ...make(), name: "healthy" })
        draft.add({
          name: "phone_type",
          input: Schema.Struct({}),
          execute: () => Effect.succeed({ content: "ok" }),
        } as unknown as Info)
        draft.add({ ...make(), name: "codemode" })
      })

      expect(output).toEqual([
        [
          "Skipping invalid tool registration",
          {
            name: "phone_type",
            namespace: undefined,
            error: expect.stringContaining('Expected string\n  at ["description"]'),
          },
        ],
      ])
      const snapshot = yield* service.snapshot()
      expect(snapshot.definitions.map((tool) => tool.name)).toEqual(["execute"])
      expect(snapshot.codeModeCatalog?.map((tool) => tool.path)).toEqual(["codemode", "healthy"])
      expect((yield* snapshot.execute(call("phone_type")).pipe(Effect.flip)).message).toBe("Unknown tool: phone_type")
    }).pipe(Effect.provide(Logger.layer([logger])))
  })

  it.effect("skipped registrations leave existing tools and scoped cleanup intact", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, { echo: constant("original") })
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* service.transform((draft) => {
            draft.add({ ...constant("invalid"), name: "echo", description: undefined } as unknown as Info)
            draft.add({ ...make(), name: "temporary" })
          })
          expect(yield* codeModeTools(service)).toEqual(["echo", "temporary"])
          expect((yield* executeTool(service, call("echo"))).output).toEqual({ text: "original" })
        }),
      )
      expect(yield* codeModeTools(service)).toEqual(["echo"])
    }),
  )

  it.effect("canonicalizes the catalog independently of registration order", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const tool = make()
      const capture = (tools: ReadonlyArray<Info>) =>
        Effect.scoped(
          Effect.gen(function* () {
            yield* service.transform((draft) => tools.forEach(draft.add))
            const snapshot = yield* service.snapshot()
            return { definitions: snapshot.definitions, catalog: snapshot.codeModeCatalog }
          }),
        )
      const first = yield* capture([
        { ...tool, name: "zeta" },
        { ...tool, name: "alpha" },
        { ...tool, name: "beta", options: { namespace: "alpha" } },
        { ...tool, name: "echo" },
      ])
      const second = yield* capture([
        { ...tool, name: "echo" },
        { ...tool, name: "beta", options: { namespace: "alpha" } },
        { ...tool, name: "alpha" },
        { ...tool, name: "zeta" },
      ])

      expect(first).toEqual(second)
      expect(first.definitions.map((definition) => definition.name)).toEqual(["execute"])
      expect(first.catalog?.map((entry) => entry.path)).toEqual(["alpha", "alpha.beta", "echo", "zeta"])
    }),
  )

  it.effect("snapshots external tools with missing input schemas", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* service.transform((draft) =>
        draft.add({
          ...make(),
          input: undefined,
        } as unknown as Info),
      )

      const snapshot = yield* service.snapshot()
      expect(snapshot.definitions.map((tool) => tool.name)).toEqual(["execute"])
      expect(snapshot.codeModeCatalog?.[0]?.signature).toContain("tools.echo")
    }),
  )

  it.effect("offers execute exactly when the permissions leave a tool to call", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service

      const empty = yield* service.snapshot()
      expect(empty.definitions).toEqual([])
      expect(empty.codeModeCatalog).toBeUndefined()

      yield* transform(service, { echo: make() })
      expect((yield* toolDefinitions(service)).map((tool) => tool.name)).toEqual(["execute"])
      expect(yield* toolDefinitions(service, [{ action: "*", resource: "*", effect: "deny" }])).toEqual([])
      expect(yield* toolDefinitions(service, [{ action: "echo", resource: "*", effect: "deny" }])).toEqual([])
      expect(
        (yield* toolDefinitions(service, [
          { action: "*", resource: "*", effect: "deny" },
          { action: "echo", resource: "*", effect: "allow" },
        ])).map((tool) => tool.name),
      ).toEqual(["execute"])
    }),
  )

  it.effect("filters disabled tools with edit aliases and ordered wildcard precedence", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, { question: make(), bash: make() })
      yield* transform(service, { edit: make(), write: make() }, { permission: "edit" })
      const names = (permissions: Permission.Ruleset) => codeModeTools(service, permissions)

      expect(yield* names([{ action: "question", resource: "*", effect: "deny" }])).toEqual(["bash", "edit", "write"])
      expect(
        yield* names([
          { action: "*", resource: "*", effect: "deny" },
          { action: "question", resource: "private", effect: "allow" },
        ]),
      ).toEqual(["question"])
      expect(
        yield* names([
          { action: "question", resource: "private", effect: "allow" },
          { action: "*", resource: "*", effect: "deny" },
        ]),
      ).toEqual([])
      expect(yield* names([{ action: "edit", resource: "*", effect: "deny" }])).toEqual(["bash", "question"])
    }),
  )

  it.effect("keeps permission options isolated between registrations", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const shared = make()
      yield* transform(service, { first: shared })
      yield* transform(service, { second: shared }, { permission: "edit" })

      expect(yield* codeModeTools(service, [{ action: "edit", resource: "*", effect: "deny" }])).toEqual(["first"])
    }),
  )

  it.effect("refuses denied and unknown tool paths before an execution exists", () =>
    Effect.gen(function* () {
      yield* seedToolSession(sessionID, identity.messageID)
      const service = yield* Tool.Service
      yield* transform(service, { echo: make(), shell: make() })
      const snapshot = yield* service.snapshot([{ action: "shell", resource: "*", effect: "deny" }], sessionID)
      const refuse = (id: string, code: string) =>
        snapshot
          .execute({ ...call("execute", id), call: { type: "tool-call", id, name: "execute", input: { code } } })
          .pipe(Effect.flip)

      const denied = yield* refuse("call-denied", 'const listing = tools.shell({ text: "ls" })')
      expect(denied.metadata).toMatchObject({ executionStatus: "refused", kind: "ToolDenied", tools: ["shell"] })
      const unknown = yield* refuse("call-unknown", 'const said = tools.ehco({ text: "hi" })')
      expect(unknown.metadata).toMatchObject({ executionStatus: "refused", kind: "UnknownTool", tools: ["ehco"] })
      expect(unknown.message).toContain("Did you mean tools.echo?")
      const db = (yield* Database.Service).db
      expect(yield* db.select({ id: CodeModeExecutionTable.id }).from(CodeModeExecutionTable).all()).toEqual([])

      expect(yield* run(snapshot, "call-allowed", 'return tools.echo({ text: "hi" })')).toMatchObject({
        status: "saved",
        summary: expect.stringContaining('{"text":"hi"}'),
      })
    }),
  )

  it.effect("removes a scoped registration", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const scope = yield* Scope.make()
      yield* transform(service, { echo: make() }).pipe(Scope.provide(scope))
      expect(yield* codeModeTools(service)).toEqual(["echo"])
      yield* Scope.close(scope, Exit.void)
      expect(yield* codeModeTools(service)).toEqual([])
    }),
  )

  it.effect("preserves an interrupted registration until its scope closes", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const scope = yield* Scope.make()
      const registered = yield* Deferred.make<void>()
      const fiber = yield* transform(service, { echo: make() }).pipe(
        Effect.andThen(Deferred.succeed(registered, undefined)),
        Effect.andThen(Effect.never),
        Scope.provide(scope),
        Effect.forkChild,
      )
      yield* Deferred.await(registered)
      yield* Fiber.interrupt(fiber)

      expect(yield* codeModeTools(service)).toEqual(["echo"])
      yield* Scope.close(scope, Exit.void)
      expect(yield* codeModeTools(service)).toEqual([])
    }),
  )

  it.effect("returns model errors without swallowing interruption or defects", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, {
        failed: {
          name: "failed",
          description: "Failed",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => Effect.fail(new Tool.Error({ message: "Denied" })),
        },
      })
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "failed", name: "failed", input: {} },
        }),
      ).toEqual({ status: "error", error: { type: "tool.execution", message: "Denied" } })
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "missing", name: "missing", input: {} },
        }),
      ).toEqual({ status: "error", error: { type: "tool.execution", message: "Unknown tool: missing" } })

      yield* transform(service, {
        defect: {
          name: "defect",
          description: "Defect",
          input: Schema.Struct({}),
          output: Schema.Struct({}),
          execute: () => Effect.die("unexpected executor defect"),
        },
      })
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "defect", name: "defect", input: {} },
        }).pipe(Effect.catchDefect(Effect.succeed)),
      ).toBe("unexpected executor defect")
    }),
  )

  it.effect("exposes execution only through a snapshot", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      expect("definitions" in service).toBe(false)
      expect("execute" in service).toBe(false)
      expect("settle" in service).toBe(false)
      expect(typeof service.snapshot).toBe("function")
    }),
  )

  it.effect("passes complete call identity to tool execution", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const contexts: Tool.Context[] = []
      yield* transform(service, {
        context: {
          name: "context",
          description: "Context",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: (_, context) => Effect.sync(() => contexts.push(context)).pipe(Effect.as({ output: { ok: true } })),
        },
      })
      yield* executeTool(service, {
        sessionID,
        ...identity,
        call: { type: "tool-call", id: "call-context", name: "context", input: {} },
      })
      expect(contexts).toEqual([
        { sessionID, ...identity, id: Tool.CallID.make("call-context"), progress: expect.any(Function) },
      ])
    }),
  )

  it.effect("publishes progress metadata unchanged", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, {
        progressive: {
          name: "progressive",
          description: "Emit image progress",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          execute: ({ text }, context) => context.progress({ stage: "capture" }).pipe(Effect.as({ output: { text } })),
        },
      })

      const updates: Tool.Metadata[] = []
      yield* executeTool(service, {
        ...call("progressive"),
        progress: (update) =>
          Effect.sync(() => {
            updates.push(update)
          }),
      })
      expect(updates).toEqual([{ stage: "capture" }])
    }),
  )

  it.effect("enforces transformed codecs at execution and projection boundaries", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      const executed: string[] = []
      const Transformed = Schema.Boolean.pipe(
        Schema.decodeTo(Schema.String, {
          decode: SchemaGetter.transform((value) => (value ? "yes" : "no")),
          encode: SchemaGetter.transform((value) => value === "yes"),
        }),
      )
      yield* transform(service, {
        transformed: {
          name: "transformed",
          description: "Transform values",
          input: Schema.Struct({ value: Transformed }),
          output: Schema.Struct({ value: Transformed }),
          execute: ({ value }) =>
            Effect.sync(() => executed.push(value)).pipe(Effect.as({ output: { value }, content: String(value) })),
        },
      })

      // Canonical content observes the decoded domain value; Code Mode observes the encoded value.
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "transformed", name: "transformed", input: { value: true } },
        }),
      ).toEqual({
        status: "completed",
        output: { value: true },
        content: [{ type: "text", text: "yes" }],
      })
      expect(executed).toEqual(["yes"])
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "invalid-input", name: "transformed", input: { value: "yes" } },
        }),
      ).toMatchObject({
        status: "error",
        error: {
          type: "tool.execution",
          message:
            'Invalid arguments for tool "transformed":\n- value: Expected boolean\n\nArguments provided:\n{\n  "value": "yes"\n}\n\nUpdate the arguments and call the tool again.',
        },
      })
      expect(executed).toEqual(["yes"])

      yield* transform(service, {
        invalid_output: {
          name: "invalid_output",
          description: "Return invalid output",
          input: Schema.Struct({}),
          output: Schema.Struct({
            value: Schema.Boolean.pipe(
              Schema.decodeTo(Schema.String, {
                decode: SchemaGetter.transform((value) => String(value)),
                encode: SchemaGetter.transformOrFail((value) =>
                  value === "valid"
                    ? Effect.succeed(true)
                    : Effect.fail(new SchemaIssue.InvalidValue({ message: "invalid output" }, value)),
                ),
              }),
            ),
          }),
          execute: () => Effect.succeed({ output: { value: "invalid" } }),
        },
      })
      expect(
        yield* executeTool(service, {
          sessionID,
          ...identity,
          call: { type: "tool-call", id: "invalid-output", name: "invalid_output", input: {} },
        }),
      ).toMatchObject({
        status: "error",
        error: { type: "tool.execution", message: expect.stringContaining("invalid value for its output schema") },
      })
    }),
  )

  it.effect("registers, advertises, and executes a Zod tool", () =>
    Effect.gen(function* () {
      yield* seedToolSession(sessionID, identity.messageID)
      const service = yield* Tool.Service
      yield* transform(service, {
        zod: {
          name: "zod",
          description: "Increment a parsed number",
          input: z.object({ count: z.string().transform(Number) }),
          output: z.object({ count: z.number() }),
          execute: ({ count }) => Effect.succeed({ output: { count: count + 1 } }),
        },
      })

      const snapshot = yield* service.snapshot()
      expect(snapshot.codeModeCatalog?.find((tool) => tool.path === "zod")?.signature).toContain("count")
      expect(yield* run(snapshot, "call-zod", 'return tools.zod({ count: "41" })')).toMatchObject({
        status: "saved",
        summary: expect.stringContaining('{"count":42}'),
      })
    }),
  )

  it.effect("executes the tool advertised in a model request", () =>
    Effect.gen(function* () {
      yield* seedToolSession(sessionID, identity.messageID)
      const service = yield* Tool.Service
      const scope = yield* Scope.make()
      yield* transform(service, { echo: constant("advertised") }).pipe(Scope.provide(scope))
      const request = yield* service.snapshot()
      yield* Scope.close(scope, Exit.void)
      yield* transform(service, { echo: constant("replacement") })

      expect(yield* run(request, "call-advertised", 'return tools.echo({ text: "echo" })')).toMatchObject({
        summary: expect.stringContaining('{"text":"advertised"}'),
      })
      expect((yield* executeTool(service, call("echo"))).content).toEqual([{ type: "text", text: "replacement" }])
    }),
  )

  it.effect("reveals the previous registration after an overlay closes", () =>
    Effect.gen(function* () {
      const service = yield* Tool.Service
      yield* transform(service, { echo: constant("base") })
      const overlay = yield* Scope.make()
      yield* transform(service, { echo: constant("overlay") }).pipe(Scope.provide(overlay))

      expect((yield* executeTool(service, call("echo"))).content).toEqual([{ type: "text", text: "overlay" }])
      yield* Scope.close(overlay, Exit.void)
      expect((yield* executeTool(service, call("echo"))).content).toEqual([{ type: "text", text: "base" }])
    }),
  )

  it.effect("executes and reports progress for codemode tools advertised in a model request", () =>
    Effect.gen(function* () {
      yield* seedToolSession(sessionID, identity.messageID)
      const service = yield* Tool.Service
      const executed: string[] = []
      const scope = yield* Scope.make()
      yield* transform(service, {
        echo: {
          name: "echo",
          description: "Echo text",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          execute: ({ text }, context) =>
            Effect.sync(() => executed.push(`old:${text}`)).pipe(
              Effect.andThen(context.progress({ stage: "old" })),
              Effect.as({ output: { text } }),
            ),
        },
      }).pipe(Scope.provide(scope))
      const toolSet = yield* service.snapshot()
      const execute = toolSet.definitions.find((tool) => tool.name === "execute")
      expect(toolSet.codeModeCatalog?.[0]?.signature).toContain("tools.echo")
      expect(execute?.description).toContain("JavaScript-shaped program")
      expect(execute?.description).not.toContain("Echo text")
      yield* Scope.close(scope, Exit.void)
      yield* transform(service, {
        echo: {
          name: "echo",
          description: "Echo text",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          execute: ({ text }) => Effect.sync(() => executed.push(`new:${text}`)).pipe(Effect.as({ output: { text } })),
        },
      })

      const bus = yield* Bus.Service
      let backgroundAtStarted = false
      yield* bus.project(SessionEvent.CodeMode.Started, () => {
        const jobs = testJobs
        if (!jobs) return Effect.die("Job test service is unavailable")
        return jobs.pendingBackground.pipe(
          Effect.map((items) => {
            backgroundAtStarted = items.some((item) => item.recovery.kind === "codemode")
          }),
        )
      })
      const progress: Array<SessionEvent.CodeMode.Progress["data"]["events"]> = []
      const boundedProgress: Array<SessionEvent.CodeMode.Progress["data"]["events"]> = []
      const progressFiber = yield* bus.subscribe(SessionEvent.CodeMode.Progress).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (event.data.id === "call-execute") progress.push(event.data.events)
            if (event.data.id === "call-bounded") boundedProgress.push(event.data.events)
          }),
        ),
        Effect.forkIn(yield* Scope.Scope, { startImmediately: true }),
      )
      const execution = yield* toolSet.execute({
        ...call("execute"),
        call: {
          type: "tool-call",
          id: "call-execute",
          name: "execute",
          input: { code: 'const answer = tools.echo({ text: "request" })' },
        },
      })

      expect(backgroundAtStarted).toBe(true)
      expect(yield* waitCodeMode(execution.output, "call-execute")).toMatchObject({
        status: "saved",
        saved: ["answer"],
        summary: expect.stringContaining("answer"),
      })
      expect(yield* readCodeModeNotebook(sessionID)).toMatchObject({ answer: { text: "request" } })
      expect(executed).toEqual(["old:request"])
      expect(progress.at(-1)).toEqual([
        {
          type: "tool",
          tool: "echo",
          status: "completed",
          input: { text: "request" },
          output: '{"text":"request"}',
          metadata: { stage: "old" },
        },
        { type: "trace", kind: "assignment", target: "answer", value: "{ text: request }" },
        { type: "trace", kind: "return", value: "undefined" },
      ])

      const bounded = yield* toolSet.execute({
        ...call("execute"),
        call: {
          type: "tool-call",
          id: "call-bounded",
          name: "execute",
          input: {
            code: 'console.log("\u{1F600}".repeat(5000)); return Array.from({ length: 101 }, (_, index) => tools.echo({ text: String.fromCharCode(0).repeat(5000) + index }))',
          },
        },
      })
      const boundedOutcome = yield* waitCodeMode(bounded.output, "call-bounded")
      expect(boundedOutcome).toMatchObject({
        status: "failed",
        saved: [],
        error: expect.stringContaining("tool-call limit"),
      })
      // The completion summary is bounded even when the program logged and returned far more.
      expect(new TextEncoder().encode(boundedOutcome.summary).length).toBeLessThanOrEqual(8 * 1024)
      yield* Fiber.interrupt(progressFiber)
      const boundedEvents = boundedProgress.at(-1) ?? []
      expect(boundedEvents.filter((event) => event.type === "tool").length).toBeLessThanOrEqual(100)
      expect(new TextEncoder().encode(JSON.stringify(boundedEvents)).length).toBeLessThanOrEqual(256 * 1024)
      expect(boundedEvents.find((event) => event.type === "tool")).toMatchObject({
        input: { truncated: expect.any(String) },
        output: expect.any(String),
      })
      const first = boundedEvents.find((event) => event.type === "tool")
      const output = first?.output ?? ""
      expect(new TextEncoder().encode(JSON.stringify(first?.input)).length).toBeLessThanOrEqual(4 * 1024)
      expect(new TextEncoder().encode(JSON.stringify(output)).length).toBeLessThanOrEqual(4 * 1024)
      const log = boundedEvents.find((event) => event.type === "trace" && event.kind === "log")
      expect(log).toMatchObject({ message: expect.any(String) })
      expect(
        new TextEncoder().encode(JSON.stringify(log?.kind === "log" ? log.message : "")).length,
      ).toBeLessThanOrEqual(4 * 1024)
    }),
  )

  it.effect("attaches images and PDFs returned by tool calls to the completion notification", () =>
    Effect.gen(function* () {
      yield* seedToolSession(sessionID, identity.messageID)
      const service = yield* Tool.Service
      yield* transform(service, {
        capture: {
          name: "capture",
          description: "Return media",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          execute: ({ text }) =>
            Effect.succeed({
              output: { text },
              content: [
                png("frame.png"),
                png("corrupt.png", "corrupt"),
                png("too-large.png", "large"),
                {
                  type: "file",
                  uri: "data:application/pdf;base64,JVBERg==",
                  mime: "application/pdf",
                  name: "spec.pdf",
                },
                // Only inline images and PDFs attach; references and other types stay with the tool.
                { type: "file", uri: "file:///project/remote.png", mime: "image/png", name: "remote.png" },
                { type: "file", uri: "data:text/plain;base64,dGV4dA==", mime: "text/plain", name: "notes.txt" },
                { type: "text", text },
              ],
            }),
        },
      })

      // The second call returns the same files, which attach once.
      const outcome = yield* run(
        yield* service.snapshot(),
        "call-media",
        'const first = tools.capture({ text: "one" })\nconst again = tools.capture({ text: "two" })',
      )
      expect(outcome).toMatchObject({ status: "saved" })
      const delivered = yield* deliveredFor(outcome.id)
      expect(delivered.files).toEqual([
        { data: "aW1hZ2Ugbm9ybWFsaXplZA==", mime: "image/jpeg", source: { type: "inline" }, name: "frame.png" },
        { data: "JVBERg==", mime: "application/pdf", source: { type: "inline" }, name: "spec.pdf" },
      ])
      expect(delivered.text).toEndWith(
        [
          "Attached 2 files returned by tool calls: frame.png, spec.pdf.",
          "1 file omitted: could not be decoded.",
          "1 file omitted: could not be resized below the image size limit.",
        ].join("\n"),
      )
    }),
  )

  it.effect("bounds the files attached to one completion notification", () =>
    Effect.gen(function* () {
      yield* seedToolSession(sessionID, identity.messageID)
      const service = yield* Tool.Service
      yield* transform(service, {
        gallery: {
          name: "gallery",
          description: "Return many images",
          input: Schema.Struct({}),
          output: Schema.Null,
          execute: () =>
            Effect.succeed({
              output: null,
              content: Array.from({ length: 10 }, (_, index) => png(`image-${index}.png`, `image ${index}`)),
            }),
        },
      })

      const outcome = yield* run(yield* service.snapshot(), "call-gallery", "return tools.gallery({})")
      const delivered = yield* deliveredFor(outcome.id)
      expect(delivered.files).toHaveLength(8)
      expect(delivered.text).toEndWith("2 files omitted: at most 8 files attach to one completion.")
    }),
  )

  it.effect("refuses a program that redeclares a saved notebook name without running anything", () =>
    Effect.gen(function* () {
      yield* seedToolSession(sessionID, identity.messageID)
      const service = yield* Tool.Service
      const executed: Array<string> = []
      yield* transform(service, {
        echo: {
          name: "echo",
          description: "Echo text",
          input: Schema.Struct({ text: Schema.String }),
          output: Schema.Struct({ text: Schema.String }),
          execute: ({ text }) => Effect.sync(() => executed.push(text)).pipe(Effect.as({ output: { text } })),
        },
      })
      const snapshot = yield* service.snapshot()
      const first = yield* snapshot.execute({
        ...call("execute"),
        call: {
          type: "tool-call",
          id: "call-first-name",
          name: "execute",
          input: { code: 'const shared = tools.echo({ text: "first" })' },
        },
      })
      expect(yield* waitCodeMode(first.output, "call-first-name")).toMatchObject({
        status: "saved",
        saved: ["shared"],
      })

      const refused = yield* snapshot
        .execute({
          ...call("execute"),
          call: {
            type: "tool-call",
            id: "call-redeclare",
            name: "execute",
            input: { code: 'const shared = tools.echo({ text: "second" })' },
          },
        })
        .pipe(Effect.flip)
      expect(refused.message).toContain("cannot be redefined")
      expect(refused.metadata).toMatchObject({ kind: "NameAlreadyDefined", names: ["shared"] })
      // A refused program never runs, so its tool call never happened.
      expect(executed).toEqual(["first"])
      const store = yield* CodeModeStore.Service
      expect(yield* store.reservations(sessionID)).toEqual([])
    }),
  )

  it.effect("settles interrupted executions durably", () =>
    Effect.gen(function* () {
      yield* seedToolSession(sessionID, identity.messageID)
      const service = yield* Tool.Service
      const gate = yield* Deferred.make<void>()
      yield* transform(service, {
        blocked: {
          name: "blocked",
          description: "Never completes",
          input: Schema.Struct({}),
          output: Schema.Null,
          execute: () => Deferred.await(gate).pipe(Effect.as({ output: null })),
        },
      })
      const started = yield* Deferred.make<CodeModeExecution.ID>()
      const bus = yield* Bus.Service
      yield* bus.project(SessionEvent.CodeMode.Started, (event) =>
        event.data.id === "call-interrupted" ? Deferred.succeed(started, event.data.executionID) : Effect.void,
      )
      const snapshot = yield* service.snapshot()
      const scope = yield* Scope.Scope
      const fiber = yield* snapshot
        .execute({
          ...call("execute"),
          call: {
            type: "tool-call",
            id: "call-interrupted",
            name: "execute",
            input: { code: "return tools.blocked({})" },
          },
        })
        .pipe(Effect.forkIn(scope, { startImmediately: true }))
      const executionID = yield* Deferred.await(started)
      // Release the outer tool result so the execution starts, then cancel it while a tool blocks.
      yield* bus.publish(SessionEvent.Tool.Success, {
        sessionID,
        assistantMessageID: identity.messageID,
        id: "call-interrupted",
        content: [{ type: "text", text: "Execution started" }],
        executed: false,
      })
      const store = yield* CodeModeStore.Service
      while ((yield* store.get(executionID))?.status !== "running") yield* Effect.promise(() => Bun.sleep(1))
      const jobs = testJobs ?? (yield* Effect.die("Job test service is unavailable"))
      yield* jobs.cancel(executionID)
      yield* Fiber.interrupt(fiber)
      expect(yield* store.get(executionID)).toMatchObject({ status: "indeterminate", saved: [] })
      expect(yield* store.bindings(sessionID)).toEqual({})
      expect(yield* store.reservations(sessionID)).toEqual([])
    }),
  )
})
