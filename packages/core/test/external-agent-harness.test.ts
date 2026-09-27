import { beforeEach, describe, expect } from "bun:test"
import { ToolHandle } from "@ocpp/codemode"
import { Effect, Layer, Schema, Stream } from "effect"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { ExternalSession } from "@ocpp/schema/external-session"
import { SessionDriver } from "@ocpp/schema/session-driver"
import { Agent } from "@ocpp/core/agent"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { Bus } from "@ocpp/core/bus"
import { CodeModeCommand } from "@ocpp/core/codemode/command"
import { CodeModeEvent } from "@ocpp/core/codemode/event"
import { CodeModeResume } from "@ocpp/core/codemode/resume"
import { CodeModeStore } from "@ocpp/core/codemode/store"
import { Database } from "@ocpp/core/database/database"
import { ExternalAgentDriver } from "@ocpp/core/external-agent/driver"
import { ExternalAgentDrivers } from "@ocpp/core/external-agent/drivers"
import { ExternalAgentSession } from "@ocpp/core/external-agent/session"
import { Job } from "@ocpp/core/job"
import { Location } from "@ocpp/core/location"
import { LocationServiceMap } from "@ocpp/core/location-services"
import { Model } from "@ocpp/core/model"
import { PluginRuntime } from "@ocpp/core/plugin/runtime"
import { PluginSupervisor } from "@ocpp/core/plugin/supervisor-service"
import { Project } from "@ocpp/core/project"
import { Provider } from "@ocpp/core/provider"
import { AbsolutePath } from "@ocpp/core/schema"
import { Session } from "@ocpp/core/session"
import { SessionEnvironment } from "@ocpp/core/session/environment"
import { SessionEvent } from "@ocpp/core/session/event"
import { SessionExecution } from "@ocpp/core/session/execution"
import { SessionRestart } from "@ocpp/core/session/execution/restart"
import { SessionMessage } from "@ocpp/core/session/message"
import { SessionModelTransport } from "@ocpp/core/session/model-transport"
import { SessionProjector } from "@ocpp/core/session/projector"
import { SessionStore } from "@ocpp/core/session/store"
import { Tool } from "@ocpp/core/tool"
import { SubagentTool } from "@ocpp/core/tool/plugin/subagent"
import { execute } from "@ocpp/core/tool/runtime"
import { testEffect } from "./lib/effect"
import { globalProjectNode } from "./lib/project"
import { registeredTools } from "./lib/tool"
import { tmpdirScoped } from "./fixture/tmpdir"
import { vendorDrivers } from "./lib/drivers"
import { SessionTable } from "@ocpp/core/session/sql"
import { desc, eq } from "drizzle-orm"

type Turn = (options: ExternalAgentDriver.Options, message: string) => Promise<void>

/** A scripted vendor: one run per drain, one `turn` per delivered message, like the Claude, Codex and Pi drivers. */
const vendor = {
  ready: { claude: true, codex: true, pi: true } as Record<ExternalSession.Provider, boolean>,
  runs: [] as Array<ExternalAgentDriver.Options & { readonly provider: ExternalSession.Provider }>,
  messages: [] as string[],
  sessions: new Map<string, string>(),
  turn: (async () => {}) as Turn,
}
const fake = (provider: ExternalSession.Provider): ExternalAgentDriver.Driver => ({
  provider,
  inspect: async (_directory, id) => vendor.sessions.get(id),
  async run(options) {
    vendor.runs.push({ ...options, provider })
    const id = options.vendorSessionID ?? provider + "-" + crypto.randomUUID()
    await options.linked(id)
    try {
      const pending = { message: options.message as string | undefined }
      while (pending.message !== undefined) {
        vendor.messages.push(pending.message)
        await vendor.turn(options, pending.message)
        options.idle()
        pending.message = await options.next(options.signal)
      }
    } finally {
      vendor.sessions.set(id, String((Number(vendor.sessions.get(id)) || 0) + 1))
      await options.checkpointed(vendor.sessions.get(id)!)
    }
  },
})
const drivers = vendorDrivers({
  available: async (provider) => vendor.ready[provider],
  driver: async (provider) => fake(provider),
})
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
      SessionExecution.node,
      SessionRestart.node,
      ExternalAgentSession.node,
      LocationServiceMap.node,
      PluginRuntime.providerNode,
      CodeModeCommand.node,
      CodeModeEvent.node,
      CodeModeStore.node,
      CodeModeResume.node,
    ]),
    [
      [Project.node, globalProjectNode],
      [SessionModelTransport.node, transport],
      [ExternalAgentDrivers.node, drivers],
      [Bus.node, Bus.configured({ persist: true })],
    ],
  ),
)

beforeEach(() => {
  vendor.ready = { claude: true, codex: true, pi: true }
  vendor.runs = []
  vendor.messages = []
  vendor.turn = async () => {}
})

const ref = (provider: string, id: string, variant?: string) =>
  Model.Ref.make({
    providerID: Provider.ID.make(provider),
    id: Model.ID.make(id),
    ...(variant === undefined ? {} : { variant: Model.VariantID.make(variant) }),
  })

const setup = (model?: Model.Ref) =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped()
    const sessions = yield* Session.Service
    const session = yield* sessions.create({
      location: Location.Ref.make({ directory: AbsolutePath.make(directory.path) }),
      ...(model === undefined ? {} : { model }),
    })
    const locations = yield* LocationServiceMap.Service
    const within = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const plugins = yield* PluginSupervisor.Service
        yield* plugins.flush
        return yield* effect
      }).pipe(Effect.provide(locations.get(session.location)))
    yield* within(Effect.void)
    return { session, sessions, within, directory }
  })

const say =
  (text: string): Turn =>
  async (options) => {
    await options.emit({ type: "step-start", id: crypto.randomUUID() })
    await options.emit({ type: "text", id: "t", delta: text })
    await options.emit({ type: "usage", input: 10, output: 2, cacheRead: 0 })
    await options.emit({ type: "step-end" })
  }

/** Calls OC++'s execute the way Claude does: announce the tool_use, then call it over MCP naming that block. */
const run = async (options: ExternalAgentDriver.Options, code: string, id = "toolu_" + crypto.randomUUID()) => {
  await options.emit({ type: "step-start", id: crypto.randomUUID() })
  await options.emit({ type: "tool-start", id, name: "mcp__ocpp__execute", input: { code } })
  const result = await Effect.runPromise(Effect.result(options.gateway.invoke("execute", { code }, id)))
  await options.emit({
    type: "tool-end",
    id,
    output: result._tag === "Success" ? result.success : result.failure,
    error: result._tag === "Failure",
  })
  await options.emit({ type: "step-end" })
  return result
}

const messages = (sessionID: Session.ID) =>
  Session.Service.pipe(Effect.flatMap((sessions) => sessions.messages({ sessionID, order: "asc" })))

const texts = (list: ReadonlyArray<SessionMessage.Info>) =>
  list.flatMap((message) =>
    message.type === "assistant"
      ? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
      : message.type === "user" || message.type === "synthetic"
        ? [message.text]
        : [],
  )

describe("vendor-driven sessions", () => {
  it.live("a prompt reaches the vendor in the OC++ harness and its events project into the Session", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "sonnet", "high"))
      vendor.turn = say("Hello from Claude")
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Say hello" })
      yield* env.sessions.wait(env.session.id)
      const first = vendor.runs[0]
      expect(first).toMatchObject({ provider: "claude", model: "sonnet", effort: "high", message: "Say hello" })
      expect(first.directory).toBe(env.directory.path)
      expect(first.harness.type).toBe("ocpp")
      const system = first.harness.type === "ocpp" ? first.harness.system : ""
      // The same assembly a native model receives: OC++'s prompt with its Code Mode rules and the catalog.
      expect(system).toContain("You are an AI agent powered by OC++")
      expect(system).toContain("Your only tool is `execute`")
      expect(system).toContain("tools.read")
      expect(first.gateway.definitions.map((tool) => tool.name)).toEqual(["execute"])
      expect(texts(yield* messages(env.session.id))).toEqual(["Say hello", "Hello from Claude"])
      const assistant = (yield* messages(env.session.id)).find((message) => message.type === "assistant")
      expect(assistant).toMatchObject({ model: { providerID: "claude", id: "sonnet" } })
      const external = yield* ExternalAgentSession.Service
      expect(yield* external.get(env.session.id)).toMatchObject({
        provider: "claude",
        directory: env.directory.path,
        status: "completed",
        checkpoint: "1",
      })
      expect((yield* env.sessions.get(env.session.id)).outcome).toBe("succeeded")
    }),
  )

  it.live("execute runs Code Mode in the Session and its completion is delivered back to the vendor", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "sonnet"))
      const results: string[] = []
      vendor.turn = async (options, message) => {
        if (message.includes("saved notebook values")) return say("The total is 3")(options, message)
        const result = await run(options, "const total = 1 + 2")
        if (result._tag === "Success") results.push(result.success)
      }
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Add numbers" })
      yield* env.sessions.wait(env.session.id)
      expect(results[0]).toMatch(/^Execution exe_\w+ started/)
      // The run did not end at the vendor's idle turn: it waited for the notification and delivered it.
      expect(vendor.runs).toHaveLength(1)
      expect(vendor.messages).toHaveLength(2)
      expect(vendor.messages[1]).toContain("saved notebook values: total")
      const history = yield* messages(env.session.id)
      const tool = history
        .flatMap((message) => (message.type === "assistant" ? message.content : []))
        .find((part) => part.type === "tool")
      expect(tool).toMatchObject({ name: "execute", executed: false, state: { status: "completed" } })
      expect(history.some((message) => message.type === "synthetic" && message.metadata?.source === "codemode")).toBe(
        true,
      )
      expect(texts(history).at(-1)).toBe("The total is 3")
      const store = yield* CodeModeStore.Service
      expect((yield* store.bindings(env.session.id)).total).toBe(3)
    }),
  )

  it.live("orchestrates several executions: each completion reaches the vendor as it lands, in one vendor run", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "sonnet"))
      vendor.turn = async (options, message) => {
        if (message === "Fan out") {
          await run(options, 'const slow = tools.shell({ command: "sleep 1; echo slow done" })')
          await run(options, "const fast = 40 + 2")
          return say("Launched both; waiting.")(options, message)
        }
        return say("Noted: " + (message.includes("slow") ? "slow" : "fast"))(options, message)
      }
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Fan out" })
      yield* env.sessions.wait(env.session.id)
      expect(vendor.runs).toHaveLength(1)
      // The fast result arrives first and is answered while the slow execution is still running.
      expect(vendor.messages).toHaveLength(3)
      expect(vendor.messages[1]).toContain("saved notebook values: fast")
      expect(vendor.messages[2]).toContain("saved notebook values: slow")
      expect(texts(yield* messages(env.session.id)).filter((text) => text.startsWith("Noted"))).toEqual([
        "Noted: fast",
        "Noted: slow",
      ])
      const store = yield* CodeModeStore.Service
      expect(yield* store.bindings(env.session.id)).toMatchObject({ fast: 42 })
    }),
  )

  it.live("a running turn receives steers, as Claude's streaming input does, while queued input waits", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "sonnet"))
      const midTurn: string[] = []
      vendor.turn = async (options, message) => {
        if (message !== "Start") return say("Later: " + message)(options, message)
        await options.emit({ type: "step-start", id: "busy" })
        await options.emit({ type: "text", id: "t", delta: "Working" })
        // Still inside the turn: only steers are delivered now.
        midTurn.push((await options.next(options.signal)) ?? "none")
        await options.emit({ type: "step-end" })
      }
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Start" })
      while (vendor.messages.length === 0) yield* Effect.promise(() => Bun.sleep(5))
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Queued for later", delivery: "queue" })
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Steer now" })
      yield* env.sessions.wait(env.session.id)
      expect(midTurn).toEqual(["Steer now"])
      expect(vendor.messages).toEqual(["Start", "Queued for later"])
      expect(vendor.runs).toHaveLength(1)
    }),
  )

  it.live("an execute call is matched to a vendor announcement that arrives after the MCP call", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("codex", "gpt-5.6-sol"))
      vendor.turn = async (options, message) => {
        if (message.includes("Execution")) return say("done")(options, message)
        await options.emit({ type: "step-start", id: "codex" })
        // Codex names no call ID over MCP, and its item event can trail the MCP request.
        const pending = Effect.runPromise(options.gateway.invoke("execute", { code: "const seen = 7" }))
        await options.emit({
          type: "tool-start",
          id: "item_1",
          name: "mcp__ocpp__execute",
          input: { code: "const seen = 7" },
        })
        const output = await pending
        await options.emit({ type: "tool-end", id: "item_1", output })
        await options.emit({ type: "step-end" })
      }
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Remember seven" })
      yield* env.sessions.wait(env.session.id)
      const tools = (yield* messages(env.session.id)).flatMap((message) =>
        message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
      )
      expect(tools).toHaveLength(1)
      expect(tools[0]).toMatchObject({ id: "item_1", name: "execute", state: { status: "completed" } })
      const store = yield* CodeModeStore.Service
      expect((yield* store.bindings(env.session.id)).seen).toBe(7)
    }),
  )

  it.live("user interruption aborts the vendor run and releases the Session", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "sonnet"))
      const aborted = { value: false }
      vendor.turn = async (options) => {
        await options.emit({ type: "step-start", id: "long" })
        await options.emit({ type: "text", id: "t", delta: "Working" })
        await new Promise<void>((_resolve, reject) =>
          options.signal.addEventListener(
            "abort",
            () => {
              aborted.value = true
              reject(new Error("aborted"))
            },
            { once: true },
          ),
        )
      }
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Work for a long time" })
      while (vendor.runs.length === 0) yield* Effect.promise(() => Bun.sleep(5))
      while (vendor.messages.length === 0) yield* Effect.promise(() => Bun.sleep(5))
      yield* Effect.promise(() => Bun.sleep(20))
      expect(yield* env.sessions.interrupt(env.session.id)).toBe(true)
      yield* env.sessions.wait(env.session.id)
      expect(aborted.value).toBe(true)
      expect((yield* env.sessions.get(env.session.id)).outcome).toBe("interrupted")
      const external = yield* ExternalAgentSession.Service
      expect((yield* external.get(env.session.id))?.status).toBe("interrupted")
      const assistant = (yield* messages(env.session.id)).find((message) => message.type === "assistant")
      expect(assistant?.type === "assistant" && assistant.error?.type).toBeTruthy()
    }),
  )

  it.live("startup recovery resumes the vendor session a claimed Session left behind", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "sonnet"))
      vendor.turn = say("First answer")
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Start" })
      yield* env.sessions.wait(env.session.id)
      const external = yield* ExternalAgentSession.Service
      const store = yield* SessionStore.Service
      const restart = yield* SessionRestart.Service
      const vendorSessionID = (yield* external.get(env.session.id))?.vendorSessionID
      // A process that died mid-turn leaves its execution claim behind.
      yield* store.claim(env.session.id)
      vendor.turn = say("Continuing")
      yield* restart.resumeSuspendedSessions
      while (vendor.runs.length < 2) yield* Effect.promise(() => Bun.sleep(5))
      yield* env.sessions.wait(env.session.id)
      expect(vendor.runs).toHaveLength(2)
      expect(vendor.runs[1].vendorSessionID).toBe(vendorSessionID)
      expect(vendor.runs[1].history).toEqual([])
      expect(vendor.runs[1].message).toContain("The server restarted while you were working")
      expect(texts(yield* messages(env.session.id)).at(-1)).toBe("Continuing")
    }),
  )

  it.live("a missing vendor session or another driver rebuilds the vendor session from canonical history", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "sonnet"))
      vendor.turn = say("Answer one")
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "One" })
      yield* env.sessions.wait(env.session.id)
      // The Session changes driver through the ordinary model API.
      yield* env.sessions.switchModel({ sessionID: env.session.id, model: ref("codex", "gpt-5.6-sol", "high") })
      vendor.turn = say("Answer two")
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Two" })
      yield* env.sessions.wait(env.session.id)
      expect(vendor.runs[1]).toMatchObject({ provider: "codex", model: "gpt-5.6-sol", effort: "high", message: "Two" })
      expect(vendor.runs[1].vendorSessionID).toBeUndefined()
      expect(vendor.runs[1].history).toEqual([
        { role: "user", text: "One" },
        { role: "assistant", text: "Answer one" },
      ])
      const external = yield* ExternalAgentSession.Service
      const record = yield* external.get(env.session.id)
      expect(record?.provider).toBe("codex")
      vendor.sessions.delete(record!.vendorSessionID!)
      vendor.turn = say("Answer three")
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Three" })
      yield* env.sessions.wait(env.session.id)
      expect(vendor.runs[2].vendorSessionID).toBeUndefined()
      expect(vendor.runs[2].history).toHaveLength(4)
    }),
  )

  it.live("a vendor whose CLI or login is missing fails the Session with a clear error", () =>
    Effect.gen(function* () {
      vendor.ready.codex = false
      const env = yield* setup(ref("codex", "gpt-5.6-sol"))
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Hello" })
      yield* env.sessions.wait(env.session.id)
      expect(vendor.runs).toHaveLength(0)
      expect((yield* env.sessions.get(env.session.id)).outcome).toBe("failed")
      const log = Array.from(yield* Stream.runCollect(env.sessions.log({ sessionID: env.session.id })))
      const failed = log.find((event) => event.type === SessionEvent.Execution.Failed.type)
      expect(JSON.stringify(failed)).toContain("Codex is not available on this machine")
      expect(JSON.stringify(failed)).toContain("codex login")
    }),
  )
})

describe("subagent drivers", () => {
  const call = (env: Effect.Success<ReturnType<typeof setup>>, input: Record<string, unknown>) =>
    env.within(
      Effect.gen(function* () {
        const registry = yield* Tool.Service
        const tool = (yield* registeredTools(registry)).get(SubagentTool.name)
        if (!tool) return yield* Effect.die("subagent is not registered")
        return yield* Effect.result(
          execute(
            tool,
            { agent: "general", description: "Task", message: "Do the task", ...input },
            {
              sessionID: env.session.id,
              agent: Agent.ID.make("build"),
              messageID: SessionMessage.ID.create(),
              id: Tool.CallID.make(crypto.randomUUID()),
              progress: () => Effect.void,
            },
          ),
        )
      }),
    )
  const child = (env: Effect.Success<ReturnType<typeof setup>>) =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const row = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.parent_id, env.session.id))
        .orderBy(desc(SessionTable.time_created))
        .get()
        .pipe(Effect.orDie)
      return row === undefined ? undefined : yield* env.sessions.get(Session.ID.make(row.id))
    })

  it.live("defaults to the parent's driver, and an explicit driver wins", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "opus", "high"))
      vendor.turn = say("Child answer")
      const inherited = yield* call(env, {})
      expect(inherited._tag).toBe("Success")
      expect(vendor.runs.at(-1)).toMatchObject({ provider: "claude", model: "opus", effort: "high" })
      expect(vendor.runs.at(-1)?.harness.type).toBe("ocpp")
      const overridden = yield* call(env, { driver: "codex" })
      expect(overridden._tag).toBe("Success")
      expect(vendor.runs.at(-1)).toMatchObject({ provider: "codex", model: "gpt-5.6-sol" })
      expect(SessionDriver.of((yield* child(env))?.model)).toBe("codex")
      if (overridden._tag === "Success")
        expect(overridden.success.content).toEqual([{ type: "text", text: expect.stringContaining("Child answer") }])
    }),
  )

  it.live("an ocpp parent gives an ocpp child, and the native harness is refused for it", () =>
    Effect.gen(function* () {
      const env = yield* setup()
      const refused = yield* call(env, { harness: "native" })
      expect(refused._tag).toBe("Failure")
      if (refused._tag === "Failure") expect(refused.failure.message).toContain('harness "native"')
      // With no provider model configured the runner cannot start the child, but no vendor was asked to.
      yield* call(env, {})
      expect(vendor.runs).toHaveLength(0)
      expect(SessionDriver.of((yield* child(env))?.model)).toBe("ocpp")
    }),
  )

  it.live(
    "a vendor subagent keeps the whole subagent contract: machine input, custom tools, submit_result, continuation",
    () =>
      Effect.gen(function* () {
        const env = yield* setup()
        const handle = new ToolHandle(
          {
            name: "count",
            description: "Count up",
            capabilities: [],
            inputSchema: { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
            outputSchema: { type: "number" },
          },
          (value) => Effect.succeed(Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(value).count + 1),
        )
        vendor.turn = async (options, message) => {
          if (message.includes("Continue")) return say("Continued")(options, message)
          if (message.includes("Execution")) return
          await run(
            options,
            'const counted = tools.count({ count: input.count }); const submitted = tools.submit_result({ message: "done", output: { count: counted, token: input.token } })',
          )
        }
        const first = yield* call(env, {
          driver: "claude",
          input: { count: 7, token: "private-token" },
          tools: [handle],
          outputSchema: {
            type: "object",
            properties: { count: { type: "number" }, token: { type: "string" } },
            required: ["count", "token"],
          },
        })
        expect(first._tag).toBe("Success")
        if (first._tag !== "Success") return
        expect(first.success.output).toMatchObject({
          status: "completed",
          message: "done",
          output: { count: 8, token: "private-token" },
        })
        expect(JSON.stringify(first.success.content)).not.toContain("private-token")
        expect(vendor.runs[0].message).not.toContain("private-token")
        const system = vendor.runs[0].harness.type === "ocpp" ? vendor.runs[0].harness.system : ""
        // The call's own tools join the child's catalog; the vendor still sees only execute.
        expect(system).toContain("tools.count")
        expect(system).toContain("tools.submit_result")
        expect(vendor.runs[0].gateway.definitions.map((tool) => tool.name)).toEqual(["execute"])
        const sessionID = Schema.decodeUnknownSync(SubagentTool.Output)(first.success.output).sessionID
        const vendorSessionID = vendor.runs[0].vendorSessionID
        expect(vendorSessionID).toBeUndefined()
        const continued = yield* call(env, { sessionID, message: "Continue please" })
        expect(continued._tag).toBe("Success")
        expect(vendor.runs.at(-1)?.provider).toBe("claude")
        const external = yield* ExternalAgentSession.Service
        expect(vendor.runs.at(-1)?.vendorSessionID).toBe((yield* external.get(sessionID))?.vendorSessionID)
        expect(vendor.runs.at(-1)?.message).toContain("Continue please")
        if (continued._tag === "Success") expect(continued.success.output).toMatchObject({ message: "Continued" })
      }),
  )

  it.live("the native harness keeps vendor tools and adds OC++ execute and the call's tools over MCP", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("codex", "gpt-5.6-sol"))
      const handle = new ToolHandle(
        {
          name: "double",
          description: "Double",
          capabilities: [],
          inputSchema: { type: "object", properties: { value: { type: "number" } }, required: ["value"] },
          outputSchema: { type: "number" },
        },
        (value) => Effect.succeed(Schema.decodeUnknownSync(Schema.Struct({ value: Schema.Number }))(value).value * 2),
      )
      const doubled: string[] = []
      vendor.turn = async (options, message) => {
        const result = await Effect.runPromise(options.gateway.invoke("double", { value: 21 }))
        doubled.push(result)
        await options.emit({ type: "step-start", id: "native" })
        await options.emit({ type: "tool-start", id: "shell", name: "command_execution", input: { command: "ls" } })
        await options.emit({ type: "tool-end", id: "shell", output: "README.md" })
        await Effect.runPromise(
          options.gateway.invoke("submit_result", { message: "native done", output: { doubled: Number(result) } }),
        )
        await options.emit({ type: "step-end" })
        void message
      }
      const result = yield* call(env, {
        harness: "native",
        tools: [handle],
        outputSchema: { type: "object", properties: { doubled: { type: "number" } }, required: ["doubled"] },
      })
      expect(result._tag).toBe("Success")
      const native = vendor.runs[0]
      expect(native.provider).toBe("codex")
      expect(native.harness).toEqual({ type: "native" })
      expect(native.gateway.definitions.map((tool) => tool.name).toSorted()).toEqual([
        "double",
        "execute",
        "submit_result",
      ])
      expect(doubled).toEqual(["42"])
      if (result._tag === "Success")
        expect(result.success.output).toMatchObject({ message: "native done", output: { doubled: 42 } })
      // The vendor's own tool calls stay inspectable in the child timeline.
      const sessionID =
        result._tag === "Success"
          ? Schema.decodeUnknownSync(SubagentTool.Output)(result.success.output).sessionID
          : undefined
      const tools = (yield* messages(sessionID!)).flatMap((message) =>
        message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
      )
      expect(tools.map((tool) => tool.type === "tool" && tool.name)).toContain("command_execution")

      // The harness belongs to the call: continuing the same child without it runs in the OC++ harness.
      vendor.turn = say("Harnessed again")
      const continued = yield* call(env, { sessionID, message: "Continue" })
      expect(continued._tag).toBe("Success")
      expect(vendor.runs.at(-1)?.harness.type).toBe("ocpp")
      expect(vendor.runs.at(-1)?.gateway.definitions.map((tool) => tool.name)).toEqual(["execute"])
    }),
  )
})
