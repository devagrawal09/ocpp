import { beforeEach, describe, expect } from "bun:test"
import { mkdir, realpath, symlink } from "node:fs/promises"
import path from "node:path"
import { CodeMode, ToolHandle, ToolReference } from "@ocpp/codemode"
import { CodeModeBindingTable } from "@ocpp/core/codemode/sql"
import { LanguageModel, type LLMRequest } from "@ocpp/ai"
import { OpenAIChat } from "@ocpp/ai/protocols"
import { TestLLM } from "@ocpp/ai/testing"
import { LayerNodePlatform } from "@ocpp/core/effect/app-node-platform"
import { SessionRunnerModel } from "@ocpp/core/session/runner/model"
import { Cause, Deferred, Effect, Fiber, Layer, Queue, Schema, Stream, type Types } from "effect"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { ExternalSession } from "@ocpp/schema/external-session"
import { SessionDriver } from "@ocpp/schema/session-driver"
import { WorkspaceID } from "@ocpp/schema/workspace-id"
import { Agent } from "@ocpp/core/agent"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { Bus } from "@ocpp/core/bus"
import { CodeModeCommand } from "@ocpp/core/codemode/command"
import { CodeModeTool } from "@ocpp/core/codemode/tool"
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
  runs: [] as Array<
    Omit<ExternalAgentDriver.Options, "message"> & {
      readonly provider: ExternalSession.Provider
      readonly message: string
      readonly input: ExternalAgentDriver.Input
    }
  >,
  messages: [] as string[],
  /** Each delivered input as the real driver hands it to its SDK. */
  wire: [] as unknown[],
  sessions: new Map<string, string>(),
  turn: (async () => {}) as Turn,
}
/** Delivered input as text, each attachment by its type. */
const plain = (input: ExternalAgentDriver.Input) =>
  input.map((part) => (part.type === "text" ? part.text : `[${part.mime}]`)).join("\n\n")
/** Input in the provider's SDK format, from the real driver's conversion. Codex's images are written to `directory`. */
const wire = async (provider: ExternalSession.Provider, delivered: ExternalAgentDriver.Input, directory: string) => {
  if (provider === "claude") {
    const { message } = await import("@ocpp/core/external-agent/claude.node")
    return message(delivered)
  }
  if (provider === "codex") {
    const { input } = await import("@ocpp/core/external-agent/codex.node")
    return input(delivered, directory)
  }
  const { prompt } = await import("@ocpp/core/external-agent/pi.node")
  return prompt(delivered)
}
const fake = (provider: ExternalSession.Provider): ExternalAgentDriver.Driver => ({
  provider,
  inspect: async (_directory, id) => vendor.sessions.get(id),
  async run(options) {
    vendor.runs.push({ ...options, provider, message: plain(options.message), input: options.message })
    const id = options.vendorSessionID ?? provider + "-" + crypto.randomUUID()
    await options.linked(id)
    try {
      const pending = { message: options.message as ExternalAgentDriver.Input | undefined }
      while (pending.message !== undefined) {
        vendor.messages.push(plain(pending.message))
        vendor.wire.push(await wire(provider, pending.message, options.directory))
        await vendor.turn(options, plain(pending.message))
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
const nodes = LayerNode.group([
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
])
const replacements = [
  [Project.node, globalProjectNode],
  [SessionModelTransport.node, transport],
  [ExternalAgentDrivers.node, drivers],
  [Bus.node, Bus.configured({ persist: true })],
] satisfies LayerNode.Replacements
const it = testEffect(AppNodeBuilder.build(nodes, replacements))
// Projects resolved from the filesystem as a host resolves them, git worktrees included.
const projectIt = testEffect(
  AppNodeBuilder.build(
    nodes,
    replacements.filter(([node]) => node !== Project.node),
  ),
)
// OC++-driven children on the real runner, whose scripted model reads a relative path and submits what it found.
const runnerRequests: Array<LLMRequest> = []
const runnerIt = testEffect(
  AppNodeBuilder.build(nodes, [
    ...replacements,
    [
      LayerNodePlatform.llmClient,
      TestLLM.testLayer({
        transformRequest: (request) => {
          runnerRequests.push(request)
          return request
        },
        fallback: TestLLM.tool("call-read", "execute", {
          code: [
            'const found = tools.read({ path: "marker.txt" })',
            'return tools.submit_result({ message: "read", output: { found: JSON.stringify(found) } })',
          ].join("\n"),
        }),
      }),
    ],
    [
      SessionRunnerModel.node,
      Layer.succeed(SessionRunnerModel.Service, {
        resolve: () =>
          Effect.succeed(
            SessionRunnerModel.resolved(
              LanguageModel.make({ id: "child", provider: "test", route: OpenAIChat.route }),
              {
                capabilities: { tools: true, input: ["text"], output: ["text"] },
                cost: [],
                limit: { context: 200_000, output: 32_000 },
              },
            ),
          ),
      }),
    ],
  ]),
)

beforeEach(() => {
  vendor.ready = { claude: true, codex: true, pi: true }
  vendor.runs = []
  vendor.messages = []
  vendor.wire = []
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
  it.live("keeps a vendor session's notebook checkpoint until the vendor session is rebuilt", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "sonnet"))
      const database = yield* Database.Service
      const external = yield* ExternalAgentSession.Service
      const save = (executionID: string, code: string) =>
        Effect.gen(function* () {
          const saved = yield* CodeMode.execute({ code })
          if (!saved.ok) throw new Error(saved.error.message)
          yield* database.db
            .insert(CodeModeBindingTable)
            .values(
              Object.entries(saved.declarations).map(([name, value]) => ({
                session_id: env.session.id,
                name,
                value,
                message_seq: 0,
                execution_id: executionID,
              })),
            )
            .run()
        })
      const system = (index: number) => {
        const harness = vendor.runs[index].harness
        if (harness.type !== "ocpp") throw new Error("Expected the OC++ harness")
        return harness.system
      }
      const turn = Effect.fnUntraced(function* (text: string) {
        vendor.turn = say("Answered " + text)
        yield* env.sessions.prompt({ sessionID: env.session.id, text })
        yield* env.sessions.wait(env.session.id)
      })

      yield* save(
        "exe_vendor_notebook",
        "const savedData = { answer: 42 }; function savedHelper(x) { return savedData.answer + x }",
      )
      yield* turn("Continue")
      expect(vendor.runs[0].vendorSessionID).toBeUndefined()
      expect(system(0)).toContain("2 saved identifiers; 0 omitted")
      expect(system(0)).toContain("function savedHelper(x)")
      expect(system(0)).toContain("savedData")

      // A resumed vendor session keeps identical instructions; later values arrive as notifications.
      yield* save("exe_vendor_later", "const laterValue = 1")
      yield* turn("Again")
      const linked = (yield* external.get(env.session.id))?.vendorSessionID
      expect(vendor.runs[1].vendorSessionID).toBe(linked)
      expect(system(1)).toBe(system(0))

      // Rebuilding the vendor session from canonical history checkpoints the notebook as it stands.
      vendor.sessions.delete(linked!)
      yield* turn("Rebuild")
      expect(vendor.runs[2].vendorSessionID).toBeUndefined()
      expect(system(2)).toContain("3 saved identifiers; 0 omitted")
      expect(system(2)).toContain("laterValue")
      expect([...((yield* external.get(env.session.id))?.notebook ?? [])].sort()).toEqual([
        "laterValue",
        "savedData",
        "savedHelper",
      ])
    }),
  )

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

  it.live("a step shows an init.ts that fails in the Session timeline, naming the file, and offers no tools", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "sonnet"))
      const file = path.join(env.directory.path, ".ocpp", "init.ts")
      yield* Effect.promise(() => Bun.write(file, 'throw new Error("no lists today")'))
      vendor.turn = say("Nothing to call")
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Hello" })
      yield* env.sessions.wait(env.session.id)
      expect(vendor.runs[0].gateway.definitions).toEqual([])
      const notice = `${file} failed: Uncaught: no lists today This session has no tools until that is fixed.`
      const inbox = (yield* env.sessions.inbox(env.session.id)).flatMap((item) =>
        item.type === "synthetic" ? [item.payload.text] : [],
      )
      expect([...texts(yield* messages(env.session.id)), ...inbox].filter((text) => text === notice)).toHaveLength(1)
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
      // Between checkpoints the completion notification, not the instructions, announces the saved name.
      const system = (index: number) => {
        const harness = vendor.runs[index].harness
        return harness.type === "ocpp" ? harness.system : ""
      }
      expect(system(0)).not.toContain("Durable Notebook")
      vendor.turn = say("Still 3")
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Again" })
      yield* env.sessions.wait(env.session.id)
      const external = yield* ExternalAgentSession.Service
      expect(vendor.runs[1].vendorSessionID).toBeString()
      expect(vendor.runs[1].vendorSessionID).toBe((yield* external.get(env.session.id))?.vendorSessionID)
      expect(system(1)).toBe(system(0))
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
        const steer = await options.next(options.signal)
        midTurn.push(steer === undefined ? "none" : plain(steer))
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
      // The failure answers the prompt in the timeline, as a provider error does, instead of leaving it pending.
      expect(yield* env.sessions.inbox(env.session.id)).toEqual([])
      const [prompt, answer, ...rest] = yield* messages(env.session.id)
      expect(rest).toEqual([])
      expect(prompt).toMatchObject({ type: "user", text: "Hello" })
      expect(answer).toMatchObject({
        type: "assistant",
        model: { providerID: "codex", id: "gpt-5.6-sol" },
        error: { type: "driver.unavailable" },
      })
      expect(answer?.type === "assistant" ? answer.error?.message : undefined).toContain(
        "Codex is not available on this machine",
      )
    }),
  )

  it.live("a vendor run that fails before any output shows its error in the timeline", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "sonnet"))
      vendor.turn = async () => {
        throw new Error("Invalid API key · Please run /login")
      }
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Hello" })
      yield* env.sessions.wait(env.session.id)
      expect((yield* env.sessions.get(env.session.id)).outcome).toBe("failed")
      expect(yield* messages(env.session.id)).toMatchObject([
        { type: "user", text: "Hello" },
        { type: "assistant", error: { message: "Invalid API key · Please run /login" } },
      ])
    }),
  )
})

describe("vendor-driven session control", () => {
  it.live("an interrupt during an execution keeps the vendor session for the next prompt", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "sonnet"))
      const waiting = Promise.withResolvers<void>()
      vendor.turn = async (options, message) => {
        if (message !== "Start") return say("Answer")(options, message)
        await run(options, 'const slow = tools.shell({ command: "sleep 5; echo done" })')
        await say("Waiting for it.")(options, message)
        waiting.resolve()
      }
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Start" })
      yield* Effect.promise(() => waiting.promise)
      const first = vendor.runs[0]
      yield* env.sessions.interrupt(env.session.id)
      yield* env.sessions.wait(env.session.id)
      // Cancelling the execution rewrites its trace on the execute part after the vendor checkpoint.
      const settled = Effect.gen(function* () {
        const parts = (yield* messages(env.session.id)).flatMap((message) =>
          message.type === "assistant" ? message.content.filter((part) => part.type === "tool") : [],
        )
        return parts.some(
          (part) =>
            part.type === "tool" &&
            part.state.status === "completed" &&
            part.state.metadata?.executionStatus !== undefined &&
            part.state.metadata.executionStatus !== "running",
        )
      })
      while (!(yield* settled)) yield* Effect.promise(() => Bun.sleep(10))
      const external = yield* ExternalAgentSession.Service
      const linked = (yield* external.get(env.session.id))?.vendorSessionID
      expect(linked).toBeString()
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Again" })
      yield* env.sessions.wait(env.session.id)
      expect(vendor.runs.length).toBeGreaterThan(1)
      expect(first.vendorSessionID).toBeUndefined()
      // Every later run continued the same vendor session instead of rebuilding it.
      expect(vendor.runs.slice(1).map((item) => item.vendorSessionID)).toEqual(vendor.runs.slice(1).map(() => linked))
      expect(vendor.runs.at(-1)?.message).toContain("Again")
    }),
  )

  it.live("the user's shell command reaches the vendor with the next prompt, as a model would see it", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "sonnet"))
      vendor.turn = say("Hi")
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "One" })
      yield* env.sessions.wait(env.session.id)
      yield* env.sessions.shell({ sessionID: env.session.id, command: "echo shell-marker" })
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Two" })
      yield* env.sessions.wait(env.session.id)
      const message = vendor.runs.at(-1)?.message ?? ""
      expect(message).toContain("The following shell command was executed by the user")
      expect(message).toContain("shell-marker")
      expect(message.endsWith("Two")).toBe(true)
    }),
  )

  it.live("compaction is refused for a vendor-driven Session and leaves its inbox", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "sonnet"))
      vendor.turn = say("Hi")
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "One" })
      yield* env.sessions.wait(env.session.id)
      yield* env.sessions.compact({ sessionID: env.session.id })
      yield* env.sessions.wait(env.session.id)
      const log = Array.from(yield* Stream.runCollect(env.sessions.log({ sessionID: env.session.id })))
      const failed = log.find((event) => event.type === SessionEvent.Compaction.Failed.type)
      expect(failed?.type === SessionEvent.Compaction.Failed.type && failed.data.error.type).toBe(
        "compaction.unsupported",
      )
      expect(log.filter((event) => event.type === SessionEvent.InboxDelivered.type)).toHaveLength(2)
      // Refusing compaction never started the vendor.
      expect(vendor.runs).toHaveLength(1)
    }),
  )
})

// A 1x1 PNG, which prompt admission keeps byte for byte, and bytes that detect as a PDF.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
const PDF = Buffer.from("%PDF-1.4\n%OC++ attachment\n").toString("base64")
const image = { uri: "data:image/png;base64," + PNG, name: "shot.png" }
const pdf = { uri: "data:application/pdf;base64," + PDF, name: "report.pdf" }
const vendors = [ref("claude", "sonnet"), ref("codex", "gpt-5.6-sol"), ref("pi", "anthropic/claude-sonnet-4-6")]

describe("vendor attachments", () => {
  it.live("an image prompt reaches each vendor in its SDK's format, after the text", () =>
    Effect.gen(function* () {
      for (const model of vendors) {
        const env = yield* setup(model)
        vendor.turn = say("Seen")
        yield* env.sessions.prompt({ sessionID: env.session.id, text: "Describe this", files: [image] })
        yield* env.sessions.wait(env.session.id)
      }
      expect(vendor.wire[0]).toEqual({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Describe this" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
          ],
        },
        parent_tool_use_id: null,
        priority: "next",
      })
      // Codex exec takes images as files, which it reads when the turn starts.
      expect(vendor.wire[1]).toEqual([
        { type: "text", text: "Describe this" },
        { type: "local_image", path: expect.stringMatching(/\.png$/) },
      ])
      const codex = vendor.wire[1] as ReadonlyArray<{ readonly path: string }>
      expect((yield* Effect.promise(() => Bun.file(codex[1].path).bytes())).toBase64()).toBe(PNG)
      expect(vendor.wire[2]).toEqual({
        text: "Describe this",
        images: [{ type: "image", data: PNG, mimeType: "image/png" }],
      })
    }),
  )

  it.live("a PDF reaches Claude as a document, while Codex and Pi get a note naming it", () =>
    Effect.gen(function* () {
      for (const model of vendors) {
        const env = yield* setup(model)
        vendor.turn = say("Read")
        yield* env.sessions.prompt({ sessionID: env.session.id, text: "Summarize", files: [pdf] })
        yield* env.sessions.wait(env.session.id)
      }
      expect(vendor.wire[0]).toMatchObject({
        message: {
          content: [
            { type: "text", text: "Summarize" },
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: PDF },
              title: "report.pdf",
            },
          ],
        },
      })
      expect(vendor.wire[1]).toEqual([
        { type: "text", text: "Summarize" },
        {
          type: "text",
          text: "[Attached file report.pdf (application/pdf) was not forwarded: Codex takes only images]",
        },
      ])
      expect(vendor.wire[2]).toEqual({
        text: "Summarize\n\n[Attached file report.pdf (application/pdf) was not forwarded: Pi takes only images]",
        images: [],
      })
    }),
  )

  it.live("a steer with an image joins Claude's running turn as content blocks", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "sonnet"))
      const midTurn: unknown[] = []
      vendor.turn = async (options, message) => {
        if (message !== "Start") return say("Later")(options, message)
        await options.emit({ type: "step-start", id: "busy" })
        const steer = await options.next(options.signal)
        if (steer !== undefined) midTurn.push(await wire("claude", steer, options.directory))
        await say("Both seen")(options, message)
      }
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Start" })
      while (vendor.messages.length === 0) yield* Effect.promise(() => Bun.sleep(5))
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Also this one", files: [image] })
      yield* env.sessions.wait(env.session.id)
      expect(midTurn).toEqual([
        {
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "text", text: "Also this one" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: PNG } },
            ],
          },
          parent_tool_use_id: null,
          priority: "next",
        },
      ])
      expect(vendor.runs).toHaveLength(1)
    }),
  )

  it.live("an image a Code Mode run reads reaches the vendor with the run's completion", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "sonnet"))
      yield* Effect.promise(() => Bun.write(path.join(env.directory.path, "shot.png"), Buffer.from(PNG, "base64")))
      vendor.turn = async (options, message) => {
        if (message.includes("saved notebook values")) return say("A single pixel")(options, message)
        await run(options, 'const shot = tools.read({ path: "shot.png" })')
      }
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "What is in shot.png?" })
      yield* env.sessions.wait(env.session.id)
      expect(vendor.messages).toHaveLength(2)
      expect(vendor.wire[1]).toMatchObject({
        message: {
          content: [
            { type: "text", text: expect.stringContaining("shot.png") },
            { type: "image", source: { type: "base64", media_type: "image/png" } },
          ],
        },
      })
    }),
  )

  it.live("a rebuilt vendor session names an earlier attachment instead of sending it again", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "sonnet"))
      vendor.turn = say("Seen")
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Describe this", files: [image] })
      yield* env.sessions.wait(env.session.id)
      yield* env.sessions.switchModel({ sessionID: env.session.id, model: ref("codex", "gpt-5.6-sol") })
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "And now?" })
      yield* env.sessions.wait(env.session.id)
      expect(vendor.runs[1].vendorSessionID).toBeUndefined()
      expect(vendor.runs[1].history).toEqual([
        { role: "user", text: "Describe this\n[Attached file shot.png (image/png), not re-sent]" },
        { role: "assistant", text: "Seen" },
      ])
      expect(vendor.runs[1].input).toEqual([{ type: "text", text: "And now?" }])
    }),
  )

  it.live("input the vendor never answered is delivered again with its attachments", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "sonnet"))
      vendor.turn = async () => {
        throw new Error("vendor crashed")
      }
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Describe this", files: [image] })
      yield* env.sessions.wait(env.session.id)
      expect((yield* env.sessions.get(env.session.id)).outcome).toBe("failed")
      vendor.turn = say("Seen")
      yield* env.sessions.prompt({ sessionID: env.session.id, text: "Try again" })
      yield* env.sessions.wait(env.session.id)
      expect(vendor.runs[1].input).toEqual([
        { type: "text", text: "Describe this" },
        { type: "media", mime: "image/png", data: PNG, name: "shot.png" },
        { type: "text", text: "Try again" },
      ])
    }),
  )
})

describe("subagent drivers", () => {
  const call = (
    env: Pick<Effect.Success<ReturnType<typeof setup>>, "session" | "within">,
    input: Record<string, unknown>,
    options: {
      readonly source?: { readonly messageID: SessionMessage.ID; readonly id: Tool.CallID }
      // What a restarted call reports it had attached, so it rejoins that child.
      readonly recovered?: { readonly sessionID: string }
      // The caller's tool list, such as plan mode's; every registered tool when absent.
      readonly paths?: ReadonlyArray<string>
    } = {},
  ) =>
    env.within(
      Effect.gen(function* () {
        const registry = yield* Tool.Service
        const registered = yield* registeredTools(registry)
        const tool = registered.get(SubagentTool.name)
        if (!tool) return yield* Effect.die("subagent is not registered")
        return yield* Effect.result(
          execute(
            tool,
            { agent: "general", description: "Task", message: "Do the task", ...input },
            {
              sessionID: env.session.id,
              agent: Agent.ID.make("build"),
              ...(options.source ?? {
                messageID: SessionMessage.ID.create(),
                id: Tool.CallID.make(crypto.randomUUID()),
              }),
              // The caller's catalog, as Code Mode hands it to a tool that receives tool references.
              catalog: new Map(
                Array.from(registered.values())
                  .filter((item) => options.paths?.includes(CodeModeTool.qualifiedName(item)) ?? true)
                  .map((item) => [CodeModeTool.qualifiedName(item), { tool: item, lent: false }]),
              ),
              ...(options.recovered === undefined ? {} : { recovered: options.recovered }),
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

  const configure = (
    env: Pick<Effect.Success<ReturnType<typeof setup>>, "within">,
    id: string,
    edit: (agent: Types.DeepMutable<Agent.Info>) => void,
  ) =>
    env.within(
      Effect.gen(function* () {
        const agents = yield* Agent.Service
        yield* agents.transform((draft) => draft.update(Agent.ID.make(id), edit))
      }),
    )
  /** Tool references, as a program passes tools.read or the namespace tools.linear. */
  const refs = (...paths: ReadonlyArray<string>) => paths.map((item) => new ToolReference(item.split(".")))
  // A namespace only the caller's Location provides, as an MCP server configured there would.
  const linear = (env: Pick<Effect.Success<ReturnType<typeof setup>>, "within">) =>
    env.within(
      Effect.gen(function* () {
        const registry = yield* Tool.Service
        yield* registry.transform((draft) => {
          for (const name of ["create", "list"])
            draft.add({
              name,
              options: { namespace: "linear" },
              description: "Linear " + name,
              input: Schema.Struct({}),
              output: Schema.String,
              execute: () => Effect.succeed({ output: name }),
            })
        })
      }),
    )
  const listed = (env: Pick<Effect.Success<ReturnType<typeof setup>>, "sessions">, sessionID: Session.ID) =>
    env.sessions.get(sessionID).pipe(Effect.map((session) => session.tools))
  // The catalog the latest vendor run's OC++ system prompt lists.
  const listing = () => {
    const last = vendor.runs.at(-1)
    return last?.harness.type === "ocpp" ? (last.harness.system.split("## Available tools")[1] ?? "") : ""
  }
  const sessionOf = (result: Effect.Success<ReturnType<typeof call>>) =>
    result._tag === "Success"
      ? Schema.decodeUnknownSync(SubagentTool.Output)(result.success.output).sessionID
      : undefined

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
        expect(system.split("## Available tools")[1]).not.toContain("tools.read")
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

  for (const [provider, model] of [
    ["claude", "opus"],
    ["codex", "gpt-5.6-sol"],
    ["pi", "anthropic/claude-sonnet-4-6"],
  ] as const)
    it.live(`a ${provider} child's tools are exactly the tools the call passes, and a continued child keeps them`, () =>
      Effect.gen(function* () {
        const env = yield* setup(ref(provider, model))
        yield* linear(env)
        vendor.turn = say("Done")

        // Without tools a new child has none.
        const bare = yield* call(env, {})
        expect(bare._tag).toBe("Success")
        expect(vendor.runs.at(-1)?.provider).toBe(provider)
        expect(yield* listed(env, sessionOf(bare)!)).toEqual([])
        expect(listing()).not.toContain("tools.read")

        const given = yield* call(env, { tools: refs("read", "glob", "linear") })
        expect(given._tag).toBe("Success")
        const sessionID = sessionOf(given)!
        expect(yield* listed(env, sessionID)).toEqual(["glob", "linear.create", "linear.list", "read"])
        expect(listing()).toContain("tools.read")
        expect(listing()).toContain("tools.linear.create")
        expect(listing()).not.toContain("tools.grep")
        expect(listing()).not.toContain("tools.write")

        expect((yield* call(env, { sessionID, message: "Continue" }))._tag).toBe("Success")
        expect(yield* listed(env, sessionID)).toEqual(["glob", "linear.create", "linear.list", "read"])
        expect((yield* call(env, { sessionID, message: "Continue", tools: refs("grep") }))._tag).toBe("Success")
        expect(yield* listed(env, sessionID)).toEqual(["grep"])
        expect(listing()).toContain("tools.grep")
        expect(listing()).not.toContain("tools.linear")
      }),
    )

  runnerIt.live("an ocpp child's execute catalog is exactly the tools the call passes", () =>
    Effect.gen(function* () {
      const env = yield* setup()
      yield* Effect.promise(() => Bun.write(path.join(env.directory.path, "marker.txt"), "runner-marker"))
      const result = yield* call(env, {
        tools: refs("read"),
        outputSchema: { type: "object", properties: { found: { type: "string" } }, required: ["found"] },
      })
      expect(result._tag).toBe("Success")
      if (result._tag !== "Success") return
      expect(JSON.stringify(result.success.output)).toContain("runner-marker")
      expect(yield* listed(env, sessionOf(result)!)).toEqual(["read"])
      expect(vendor.runs).toHaveLength(0)
      // The child's model saw only the passed tool and the call's submit_result.
      const system = JSON.stringify(runnerRequests.at(-1)?.system)
      expect(system).toContain("tools.read")
      expect(system).toContain("tools.submit_result")
      expect(system).not.toContain("tools.glob")
      expect(system).not.toContain("tools.shell")
    }),
  )

  it.live("continuing a child drops the tools its caller no longer has, as after switching to plan mode", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "opus"))
      vendor.turn = say("Done")
      const created = yield* call(env, { tools: refs("read", "shell", "write") })
      const sessionID = sessionOf(created)!
      expect(yield* listed(env, sessionID)).toEqual(["read", "shell", "write"])

      // Still in build, a continuation keeps the whole list and says nothing about it.
      const kept = yield* call(env, { sessionID, message: "Continue" })
      expect(kept._tag === "Success" ? kept.success.output : undefined).not.toHaveProperty("notice")
      expect(yield* listed(env, sessionID)).toEqual(["read", "shell", "write"])

      // In plan mode the caller has read and subagent, but no shell or write.
      const plan = ["glob", "grep", "question", "read", "subagent", "subagent.models"]
      const refused = yield* call(env, { tools: refs("shell") }, { paths: plan })
      expect(refused._tag === "Failure" ? refused.failure.message : "").toContain(
        "tools.shell is not one of your tools",
      )
      const continued = yield* call(env, { sessionID, message: "Now run rm -rf build" }, { paths: plan })
      expect(continued._tag).toBe("Success")
      if (continued._tag !== "Success") return
      const notice =
        "The subagent no longer has tools.shell, tools.write: you no longer have those tools, and a subagent keeps only tools its caller has."
      expect(continued.success.output).toMatchObject({ notice })
      expect(continued.success.content).toEqual([{ type: "text", text: expect.stringContaining(notice) }])
      expect(yield* listed(env, sessionID)).toEqual(["read"])
      expect(listing()).toContain("tools.read")
      expect(listing()).not.toContain("tools.shell")
      expect(listing()).not.toContain("tools.write")
      // Back in build, the child does not get the tools back by being continued.
      expect((yield* call(env, { sessionID, message: "Continue" }))._tag).toBe("Success")
      expect(yield* listed(env, sessionID)).toEqual(["read"])
    }),
  )

  it.live("a call may pass only tools it has, as references, namespaces or handles", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "opus"))
      vendor.turn = say("Done")
      const failure = (result: Effect.Success<ReturnType<typeof call>>) =>
        result._tag === "Failure" ? result.failure.message : "succeeded"
      expect(failure(yield* call(env, { tools: refs("linear") }))).toContain(
        "tools.linear is not one of your tools; a subagent can be given only tools you have.",
      )
      // A tool the Location registers but the caller's list leaves out is refused the same way.
      expect(failure(yield* call(env, { tools: refs("read", "shell") }, { paths: ["read", "subagent"] }))).toContain(
        "tools.shell is not one of your tools; a subagent can be given only tools you have.",
      )
      expect(failure(yield* call(env, { tools: ["read"] }))).toContain("Tools must be tool references")
      expect(yield* child(env)).toBeUndefined()
      expect(vendor.runs).toHaveLength(0)
    }),
  )

  it.live("native: execute runs over exactly the passed tools, beside the vendor's own", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "opus"))
      yield* Effect.promise(() => Bun.write(path.join(env.directory.path, "marker.txt"), "native-marker"))
      const outcomes: string[] = []
      vendor.turn = async (options, message) => {
        if (message.includes("Execution")) return
        for (const code of [
          'const found = tools.read({ path: "marker.txt" })',
          'const written = tools.write({ path: "other.txt", content: "x" })',
        ]) {
          const result = await run(options, code)
          outcomes.push(result._tag === "Success" ? "started" : result.failure)
        }
        await say("Done")(options, message)
      }
      const result = yield* call(env, { harness: "native", tools: refs("read") })
      expect(result._tag).toBe("Success")
      expect(vendor.runs[0].harness).toEqual({ type: "native" })
      expect(vendor.runs[0].gateway.definitions.map((tool) => tool.name)).toEqual(["execute"])
      expect(outcomes[0]).toBe("started")
      expect(outcomes[1]).toContain("not available to this agent")
      const store = yield* CodeModeStore.Service
      expect(JSON.stringify((yield* store.bindings(sessionOf(result)!)).found)).toContain("native-marker")
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
      // Nor does it keep the call's handle, and without tools a child has no execute either.
      expect(vendor.runs.at(-1)?.gateway.definitions).toEqual([])
    }),
  )
  it.live("a rebuilt vendor child replays what a model saw, never private input or a Code Mode trace", () =>
    Effect.gen(function* () {
      const env = yield* setup()
      vendor.turn = async (options, message) => {
        if (message.includes("Execution")) return
        if (message.includes("Continue")) return say("Continued")(options, message)
        await run(
          options,
          'const secret = input.token; const submitted = tools.submit_result({ message: "done", output: { token: input.token } })',
        )
      }
      const first = yield* call(env, {
        driver: "claude",
        input: { token: "private-token" },
        outputSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
      })
      expect(first._tag).toBe("Success")
      // Another vendor binds again, so its new vendor session is rebuilt from canonical OC++ history.
      const continued = yield* call(env, { sessionID: sessionOf(first), driver: "codex", message: "Continue please" })
      expect(continued._tag).toBe("Success")
      const rebuilt = vendor.runs.find((item) => item.provider === "codex")!
      expect(rebuilt.vendorSessionID).toBeUndefined()
      const replayed = JSON.stringify(rebuilt.history)
      // The model-visible call and result are replayed; the trace with assignment values and the submission is not.
      expect(replayed).toContain("[execute call]")
      expect(replayed).toContain("tools.submit_result")
      expect(replayed).toContain("[execute result]")
      expect(replayed).not.toContain("private-token")
      expect(replayed).not.toContain("executionStatus")
      expect(vendor.runs.every((item) => !JSON.stringify([item.history, item.message]).includes("private-token"))).toBe(
        true,
      )
      expect(vendor.runs.at(-1)?.message).toContain("Continue please")
    }),
  )

  it.live("a new child takes its agent's configured driver, and a model ID must fit the driver", () =>
    Effect.gen(function* () {
      const env = yield* setup(ref("claude", "opus"))
      vendor.turn = say("Answered")
      yield* configure(env, "general", (agent) => {
        agent.model = ref("codex", "gpt-5.6-terra")
      })
      expect((yield* call(env, {}))._tag).toBe("Success")
      expect(vendor.runs.at(-1)).toMatchObject({ provider: "codex", model: "gpt-5.6-terra" })

      // A provider model on the agent selects the OC++ runner, whatever drives the caller.
      yield* configure(env, "general", (agent) => {
        agent.model = ref("openai", "gpt-5")
      })
      yield* call(env, {})
      expect(SessionDriver.of((yield* child(env))?.model)).toBe("ocpp")
      expect(vendor.runs).toHaveLength(1)

      const failure = (result: Effect.Success<ReturnType<typeof call>>) =>
        result._tag === "Failure" ? result.failure.message : "succeeded"
      expect(failure(yield* call(env, { driver: "claude", model: "anthropic/claude-opus-4" }))).toContain(
        "Claude Code models are named without a provider",
      )
      expect(failure(yield* call(env, { driver: "codex", model: "openai/gpt-5#high" }))).toContain(
        "Codex models are named without a provider",
      )
      expect(failure(yield* call(env, { driver: "pi", model: "sonnet" }))).toContain(
        "Pi models are named provider/model",
      )
      expect(vendor.runs).toHaveLength(1)
    }),
  )

  it.live("a vendor child with no subagent call answers a direct prompt in the OC++ harness", () =>
    Effect.gen(function* () {
      const env = yield* setup()
      vendor.turn = say("Child answer")
      const first = yield* call(env, { driver: "claude", harness: "native" })
      expect(first._tag).toBe("Success")
      const sessionID = sessionOf(first)!
      vendor.turn = say("Direct answer")
      yield* env.sessions.prompt({ sessionID, text: "Hello child" })
      yield* env.sessions.wait(sessionID)
      expect(vendor.runs).toHaveLength(2)
      expect(vendor.runs[1]).toMatchObject({ provider: "claude", harness: { type: "ocpp" } })
      expect(vendor.runs[1].message).toContain("Hello child")
      expect(texts(yield* messages(sessionID))).toContain("Direct answer")
    }),
  )

  describe("root", () => {
    // Agent definitions in another Location, such as a root's own config.
    const configureAt = (ref: Location.Ref, id: string, edit: (agent: Types.DeepMutable<Agent.Info>) => void) =>
      Effect.gen(function* () {
        const locations = yield* LocationServiceMap.Service
        yield* Effect.gen(function* () {
          const plugins = yield* PluginSupervisor.Service
          yield* plugins.flush
          const agents = yield* Agent.Service
          yield* agents.transform((draft) => draft.update(Agent.ID.make(id), edit))
        }).pipe(Effect.provide(locations.get(ref)))
      })
    const at = (directory: string) => Location.Ref.make({ directory: AbsolutePath.make(directory) })
    const worktree = Effect.gen(function* () {
      const outer = yield* tmpdirScoped()
      const directory = path.join(outer.path, "worktrees", "feature")
      yield* Effect.promise(() => mkdir(directory, { recursive: true }))
      yield* Effect.promise(() => Bun.write(path.join(directory, "marker.txt"), "root-marker"))
      return { outer: outer.path, directory }
    })
    const failure = (result: Effect.Success<ReturnType<typeof call>>) =>
      result._tag === "Failure" ? result.failure.message : "succeeded"

    it.live("a vendor child works in its root: the vendor's directory and its execute", () =>
      Effect.gen(function* () {
        const env = yield* setup()
        const root = yield* worktree
        yield* Effect.promise(() => Bun.write(path.join(env.directory.path, "marker.txt"), "parent-marker"))
        vendor.turn = async (options, message) => {
          if (message.includes("Execution")) return
          await run(options, 'const found = tools.read({ path: "marker.txt" })')
        }
        const result = yield* call(env, { driver: "claude", root: root.directory, tools: refs("read") })
        expect(result._tag).toBe("Success")
        const sessionID = sessionOf(result)!
        expect((yield* env.sessions.get(sessionID)).location.directory).toBe(AbsolutePath.make(root.directory))
        expect(vendor.runs[0].directory).toBe(root.directory)
        const store = yield* CodeModeStore.Service
        const found = JSON.stringify((yield* store.bindings(sessionID)).found)
        expect(found).toContain("root-marker")
        expect(found).not.toContain("parent-marker")
      }),
    )

    it.live("the tools passed to a rooted child must exist at its root by the same paths", () =>
      Effect.gen(function* () {
        const env = yield* setup(ref("claude", "opus"))
        const root = yield* worktree
        yield* linear(env)
        vendor.turn = say("Done")
        expect(failure(yield* call(env, { root: root.directory, tools: refs("read", "linear") }))).toContain(
          `Subagent tools do not exist in ${root.directory}: tools.linear.create, tools.linear.list`,
        )
        expect(yield* child(env)).toBeUndefined()
        const placed = yield* call(env, { root: root.directory, tools: refs("read") })
        expect(placed._tag).toBe("Success")
        expect(yield* listed(env, sessionOf(placed)!)).toEqual(["read"])
      }),
    )

    it.live("a root must be an existing directory, and each way it is not fails as the call's error", () =>
      Effect.gen(function* () {
        const env = yield* setup(ref("claude", "opus"))
        const root = yield* worktree
        yield* Effect.promise(() => symlink(path.join(root.outer, "loop"), path.join(root.outer, "loop")))
        expect(failure(yield* call(env, { root: "worktrees/feature" }))).toContain("must be an absolute directory path")
        expect(failure(yield* call(env, { root: path.join(root.directory, "missing") }))).toContain("does not exist")
        expect(failure(yield* call(env, { root: path.join(root.directory, "marker.txt") }))).toContain(
          "is not a directory",
        )
        expect(failure(yield* call(env, { root: path.join(root.directory, "marker.txt", "sub") }))).toContain(
          "is not a directory",
        )
        expect(failure(yield* call(env, { root: path.join(root.outer, "loop") }))).toContain("too many symbolic links")
        expect(vendor.runs).toHaveLength(0)
        expect(yield* child(env)).toBeUndefined()
      }),
    )

    projectIt.live("a root under another repository places the child in that repository's project", () =>
      Effect.gen(function* () {
        const env = yield* setup(ref("claude", "opus"))
        const outer = yield* tmpdirScoped()
        const repo = path.join(outer.path, "repo")
        const sub = path.join(repo, "sub")
        yield* Effect.promise(() => mkdir(sub, { recursive: true }))
        yield* Effect.promise(() => Bun.$`git init -q ${repo}`.quiet())
        vendor.turn = say("Done")
        const result = yield* call(env, { root: sub })
        expect(result._tag).toBe("Success")
        const locations = yield* LocationServiceMap.Service
        const project = yield* Location.Service.pipe(
          Effect.map((location) => location.project.directory),
          Effect.provide(locations.get((yield* env.sessions.get(sessionOf(result)!)).location)),
        )
        expect(project).toBe(AbsolutePath.make(repo))
      }),
    )

    projectIt.live("a root inside the caller's project places the child there", () =>
      Effect.gen(function* () {
        const env = yield* setup(ref("claude", "opus"))
        yield* Effect.promise(() => Bun.$`git init -q ${env.directory.path}`.quiet())
        const sub = path.join(env.directory.path, "packages", "app")
        yield* Effect.promise(() => mkdir(sub, { recursive: true }))
        vendor.turn = say("Done")
        const result = yield* call(env, { root: sub })
        expect(result._tag).toBe("Success")
        expect(vendor.runs[0].directory).toBe(sub)
      }),
    )

    it.live("a root naming the caller's own directory keeps the caller's Location, whatever its spelling", () =>
      Effect.gen(function* () {
        const env = yield* setup(ref("claude", "opus"))
        const holder = yield* tmpdirScoped()
        const link = path.join(holder.path, "link")
        yield* Effect.promise(() => symlink(env.directory.path, link))
        vendor.turn = say("Done")
        for (const root of [env.directory.path, link, env.directory.path + "/."]) {
          const result = yield* call(env, { root })
          expect(result._tag).toBe("Success")
          // Same spelling as the caller's, so nothing (the app's "in <dir>" label included) sees another directory.
          expect((yield* env.sessions.get(sessionOf(result)!)).location).toEqual(env.session.location)
        }
      }),
    )

    it.live("a caller in a workspace keeps its children there and refuses another root", () =>
      Effect.gen(function* () {
        const directory = yield* tmpdirScoped()
        const other = yield* tmpdirScoped()
        const sessions = yield* Session.Service
        const session = yield* sessions.create({
          location: Location.Ref.make({
            directory: AbsolutePath.make(directory.path),
            workspaceID: WorkspaceID.make("wrk_test"),
          }),
          model: ref("claude", "opus"),
        })
        const locations = yield* LocationServiceMap.Service
        const env = {
          session,
          sessions,
          directory,
          within: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            Effect.gen(function* () {
              const plugins = yield* PluginSupervisor.Service
              yield* plugins.flush
              return yield* effect
            }).pipe(Effect.provide(locations.get(session.location))),
        }
        vendor.turn = say("Done")
        expect(failure(yield* call(env, { root: other.path }))).toContain("not available in a workspace")
        const own = yield* call(env, { root: directory.path })
        expect(own._tag).toBe("Success")
        expect((yield* sessions.get(sessionOf(own)!)).location).toEqual(session.location)
      }),
    )

    it.live("a continued child keeps its directory and refuses another root", () =>
      Effect.gen(function* () {
        const env = yield* setup(ref("codex", "gpt-5.6-sol"))
        const root = yield* worktree
        const other = yield* tmpdirScoped()
        const link = path.join(other.path, "link")
        yield* Effect.promise(() => symlink(root.directory, link))
        vendor.turn = say("Done")
        const first = yield* call(env, { root: root.directory })
        const sessionID = sessionOf(first)!
        expect(failure(yield* call(env, { sessionID, root: other.path, message: "Continue" }))).toContain(
          `runs in ${root.directory}`,
        )
        expect((yield* call(env, { sessionID, message: "Continue" }))._tag).toBe("Success")
        // Another spelling of the same directory is that directory.
        expect((yield* call(env, { sessionID, root: link, message: "Continue" }))._tag).toBe("Success")
        expect((yield* env.sessions.get(sessionID)).location.directory).toBe(AbsolutePath.make(root.directory))
        expect(vendor.runs.map((item) => item.directory)).toEqual([root.directory, root.directory, root.directory])
      }),
    )

    it.live("a call rejoining a rooted child after a restart runs it at its root", () =>
      Effect.gen(function* () {
        const env = yield* setup(ref("claude", "opus"))
        const root = yield* worktree
        vendor.turn = say("Done")
        const first = yield* call(env, { root: root.directory })
        const sessionID = sessionOf(first)!
        const rejoined = yield* call(env, { root: root.directory }, { recovered: { sessionID } })
        expect(rejoined._tag).toBe("Success")
        expect(vendor.runs.at(-1)?.directory).toBe(root.directory)
        expect(vendor.runs.at(-1)?.message).toContain("The server restarted")
      }),
    )

    it.live("the child's agent, driver and model come from its root's own definitions", () =>
      Effect.gen(function* () {
        const env = yield* setup(ref("claude", "opus"))
        const root = yield* worktree
        vendor.turn = say("Done")
        yield* configureAt(at(root.directory), "rooted", (agent) => {
          agent.mode = "subagent"
          agent.model = ref("codex", "gpt-5.6-terra")
        })
        yield* configure(env, "caller-only", (agent) => {
          agent.mode = "subagent"
        })
        expect((yield* call(env, { agent: "rooted", root: root.directory }))._tag).toBe("Success")
        expect(vendor.runs.at(-1)).toMatchObject({
          provider: "codex",
          model: "gpt-5.6-terra",
          directory: root.directory,
        })
        expect(failure(yield* call(env, { agent: "rooted" }))).toContain("Unknown agent: rooted")
        const before = (yield* child(env))?.id
        expect(failure(yield* call(env, { agent: "caller-only", root: root.directory }))).toContain(
          `is not defined in ${root.directory}`,
        )
        // Refused before any child Session or prompt.
        expect((yield* child(env))?.id).toBe(before)
      }),
    )

    it.live("what the call alone decides is refused before any child exists", () =>
      Effect.gen(function* () {
        // Readiness is probed once per Location, so the vendor is missing from the start.
        vendor.ready.codex = false
        const env = yield* setup(ref("claude", "opus"))
        const root = yield* worktree
        expect(failure(yield* call(env, { driver: "ocpp", harness: "native", root: root.directory }))).toContain(
          'harness "native"',
        )
        expect(failure(yield* call(env, { driver: "codex", root: root.directory }))).toContain("Codex is not available")
        expect(
          failure(yield* call(env, { driver: "claude", model: "anthropic/opus", root: root.directory })),
        ).toContain("without a provider")
        expect(yield* child(env)).toBeUndefined()
      }),
    )

    runnerIt.live("an OC++ child works in its root: a relative path reads the root's file", () =>
      Effect.gen(function* () {
        const env = yield* setup()
        const root = yield* worktree
        yield* Effect.promise(() => Bun.write(path.join(env.directory.path, "marker.txt"), "parent-marker"))
        const result = yield* call(env, {
          root: root.directory,
          tools: refs("read"),
          outputSchema: { type: "object", properties: { found: { type: "string" } }, required: ["found"] },
        })
        expect(result._tag).toBe("Success")
        if (result._tag !== "Success") return
        expect((yield* env.sessions.get(sessionOf(result)!)).location.directory).toBe(AbsolutePath.make(root.directory))
        const found = JSON.stringify(result.success.output)
        expect(found).toContain("root-marker")
        expect(found).not.toContain("parent-marker")
        expect(vendor.runs).toHaveLength(0)
      }),
    )
  })
})
