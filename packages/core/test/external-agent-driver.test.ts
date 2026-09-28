import { describe, expect, test } from "bun:test"
import { chmod, mkdir, readdir } from "node:fs/promises"
import path from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { ExternalAgentDriver } from "../src/external-agent/driver"
import { ExternalAgentGateway } from "../src/external-agent/gateway"
import { ClaudeDriver, normalize } from "../src/external-agent/claude.node"
import { CodexDriver } from "../src/external-agent/codex.node"
import { PiDriver } from "../src/external-agent/pi.node"
import { ExternalAgentBridge } from "../src/external-agent/bridge.node"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { ExternalSession } from "@ocpp/schema/external-session"
import { ExternalAgentDrivers } from "../src/external-agent/drivers"
import { it } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

function collector() {
  const events: ExternalAgentDriver.Event[] = []
  return {
    events,
    emit: async (event: ExternalAgentDriver.Event) => {
      events.push(event)
    },
  }
}

describe("external SDK drivers", () => {
  test("exports separate lazy drivers and replays canonical history only into a new vendor session", () => {
    expect([ClaudeDriver.provider, CodexDriver.provider, PiDriver.provider]).toEqual(["claude", "codex", "pi"])
    const history = [
      { role: "user" as const, text: "One" },
      { role: "assistant" as const, text: "Two" },
    ]
    const message = [{ type: "text" as const, text: "Three" }]
    expect(ExternalAgentDriver.first({ history, message })).toEqual([
      { type: "text", text: "Restored canonical OC++ history:\nuser:\nOne\n\nassistant:\nTwo\n\nThree" },
    ])
    expect(ExternalAgentDriver.first({ history, message, vendorSessionID: "vendor" })).toEqual(message)
  })

  test("Claude in the OC++ harness keeps only its model loop, OC++'s prompt and OC++'s execute", async () => {
    const { settings } = await import("../src/external-agent/claude.node")
    const mcp = { type: "sdk" as const, name: "ocpp", instance: undefined as never }
    const controller = new AbortController()
    const harnessed = settings(
      {
        directory: "/work",
        model: "opus",
        effort: "high",
        harness: { type: "ocpp", system: "OC++ system prompt" },
      },
      mcp,
      controller,
    )
    expect(harnessed).toMatchObject({
      cwd: "/work",
      model: "opus",
      effort: "high",
      systemPrompt: "OC++ system prompt",
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      skills: [],
      allowedTools: ["mcp__ocpp__execute"],
      permissionMode: "dontAsk",
      mcpServers: { ocpp: mcp },
    })
    expect(harnessed.hooks).toBeUndefined()
    expect(harnessed.sandbox).toBeUndefined()
    const native = settings(
      { directory: "/work", model: "opus", harness: { type: "native" } },
      mcp,
      controller,
      "/bin/claude",
    )
    expect(native).toMatchObject({
      pathToClaudeCodeExecutable: "/bin/claude",
      settingSources: ["user", "project", "local"],
      permissionMode: "default",
      sandbox: { enabled: true, allowUnsandboxedCommands: false },
      mcpServers: { ocpp: mcp },
    })
    expect(native.systemPrompt).toBeUndefined()
    expect(native.tools).toBeUndefined()
    // OC++ does not authorize native calls: what Claude Code would ask about runs, under its sandbox and deny rules.
    expect(native.hooks).toBeUndefined()
    expect(
      await native.canUseTool!(
        "Write",
        { file_path: "file" },
        { signal: controller.signal, toolUseID: "write", requestId: "request" },
      ),
    ).toMatchObject({ behavior: "allow", updatedInput: { file_path: "file" } })
  })

  test("Codex in the OC++ harness turns off native tool features and replaces its instructions", async () => {
    const { configure, NATIVE_FEATURES } = await import("../src/external-agent/codex.node")
    const bridge = { url: "http://127.0.0.1:1/mcp" }
    const harnessed = configure(
      { directory: "/work", model: "gpt-5.6-sol", effort: "high", harness: { type: "ocpp", system: "OC++" } },
      bridge,
      "/tmp/ocpp-codex",
    )
    expect(NATIVE_FEATURES).toEqual(expect.arrayContaining(["shell_tool", "unified_exec", "multi_agent", "apps"]))
    expect(harnessed.config).toMatchObject({
      model_instructions_file: "/tmp/ocpp-codex/instructions.md",
      model_catalog_json: "/tmp/ocpp-codex/catalog.json",
      include_permissions_instructions: false,
      include_environment_context: false,
      // No project AGENTS.md reaches the model.
      project_doc_max_bytes: 0,
      skills: { include_instructions: false, bundled: { enabled: false } },
      mcp_servers: {
        ocpp: {
          url: bridge.url,
          // The credential travels in Codex's environment, never in its arguments.
          bearer_token_env_var: "OCPP_MCP_BEARER_TOKEN",
          default_tools_approval_mode: "approve",
        },
      },
    })
    expect(Object.values(harnessed.config.features as Record<string, boolean>).every((value) => value === false)).toBe(
      true,
    )
    expect(harnessed.thread).toMatchObject({
      sandboxMode: "read-only",
      webSearchMode: "disabled",
      approvalPolicy: "on-request",
      networkAccessEnabled: false,
      modelReasoningEffort: "high",
    })
    const native = configure({ directory: "/work", model: "gpt-5.6-sol", harness: { type: "native" } }, bridge)
    expect(native.config).toEqual({ features: { multi_agent: true }, mcp_servers: harnessed.config.mcp_servers })
    expect(native.thread).toMatchObject({ sandboxMode: "workspace-write", webSearchMode: "live" })
  })

  test("Claude maps partial text, thinking, progress, vendor denials and diagnostics", async () => {
    const stream = collector()
    const state = { outputTokens: 0 }
    const base = { uuid: crypto.randomUUID(), session_id: "claude", parent_tool_use_id: null }
    await normalize(
      {
        ...base,
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      },
      stream.emit,
      state,
    )
    await normalize(
      {
        ...base,
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "thinking_delta", thinking: "consider", estimated_tokens: null },
        },
      },
      stream.emit,
      state,
    )
    await normalize(
      { ...base, type: "tool_progress", tool_use_id: "t", tool_name: "Bash", elapsed_time_seconds: 2 },
      stream.emit,
      state,
    )
    await normalize(
      {
        ...base,
        type: "system",
        subtype: "permission_denied",
        tool_name: "Bash",
        tool_use_id: "t",
        message: "Vendor denied",
      },
      stream.emit,
      state,
    )
    await normalize(
      { ...base, type: "auth_status", isAuthenticating: false, output: ["secret credential must not be projected"] },
      stream.emit,
      state,
    )
    expect(stream.events).toEqual([
      { type: "text", id: "0", delta: "hello" },
      { type: "reasoning", id: "1", delta: "consider" },
      { type: "tool-progress", id: "t", metadata: { elapsed: 2 } },
      { type: "tool-end", id: "t", output: "Vendor denied", error: true },
      { type: "diagnostic", name: "auth_status" },
    ])
  })

  test("Claude's in-process MCP server offers the gateway and names the tool_use each call answers", async () => {
    const { createSdkMcpServer } = await import("@anthropic-ai/claude-agent-sdk")
    const calls: Array<{ input: Record<string, unknown>; id?: string }> = []
    const gateway = ExternalAgentGateway.make([
      {
        name: "execute",
        description: "Run code",
        inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
        invoke: (input, id) =>
          input.code === "fail"
            ? Effect.fail("CompileError: bad program")
            : Effect.sync(() => {
                calls.push({ input, id })
                return "Execution exe_1 started."
              }),
      },
    ])
    const mcp = createSdkMcpServer({ name: "ocpp", tools: [] })
    ExternalAgentBridge.handlers(mcp.instance.server, gateway, new AbortController().signal)
    const pair = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: "test", version: "1" })
    await mcp.instance.server.connect(pair[0])
    await client.connect(pair[1])
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["execute"])
      expect(
        await client.callTool({
          name: "execute",
          arguments: { code: "const a = 1" },
          _meta: { "claudecode/toolUseId": "toolu_1" },
        }),
      ).toEqual({ content: [{ type: "text", text: "Execution exe_1 started." }] })
      expect(calls).toEqual([{ input: { code: "const a = 1" }, id: "toolu_1" }])
      expect(await client.callTool({ name: "execute", arguments: { code: "fail" } })).toEqual({
        isError: true,
        content: [{ type: "text", text: "CompileError: bad program" }],
      })
      expect(await client.callTool({ name: "shell", arguments: {} })).toHaveProperty("isError", true)
    } finally {
      await client.close()
      await mcp.instance.close()
    }
  })

  test("Codex projects incremental snapshots once, native and MCP tool lifecycle, usage and errors", async () => {
    const { normalize } = await import("../src/external-agent/codex.node")
    const stream = collector()
    const seen = new Map<string, string>()
    await normalize({ type: "turn.started" }, stream.emit, seen)
    await normalize({ type: "item.updated", item: { id: "r", type: "reasoning", text: "think" } }, stream.emit, seen)
    await normalize(
      { type: "item.completed", item: { id: "r", type: "reasoning", text: "thinking" } },
      stream.emit,
      seen,
    )
    await normalize(
      {
        type: "item.completed",
        item: {
          id: "t",
          type: "command_execution",
          command: "pwd",
          aggregated_output: "/work",
          status: "completed",
          exit_code: 0,
        },
      },
      stream.emit,
      seen,
    )
    await normalize(
      {
        type: "item.completed",
        item: {
          id: "m",
          type: "mcp_tool_call",
          server: "ocpp",
          tool: "execute",
          arguments: { code: "1" },
          error: { message: "blocked" },
          status: "failed",
        },
      },
      stream.emit,
      seen,
    )
    await normalize(
      {
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          cached_input_tokens: 2,
          cache_write_input_tokens: 1,
          output_tokens: 3,
          reasoning_output_tokens: 1,
        },
      },
      stream.emit,
      seen,
    )
    expect(stream.events.filter((event) => event.type === "reasoning")).toEqual([
      { type: "reasoning", id: "r", delta: "think" },
      { type: "reasoning", id: "r", delta: "ing" },
    ])
    expect(stream.events).toContainEqual({ type: "tool-end", id: "t", output: "/work", error: false })
    expect(stream.events).toContainEqual({ type: "tool-end", id: "m", output: "blocked", error: true })
    expect(stream.events).toContainEqual({
      type: "usage",
      input: 10,
      output: 3,
      cacheRead: 2,
      cacheWrite: 1,
      reasoning: 1,
    })
    await expect(
      normalize({ type: "item.completed", item: { id: "r", type: "reasoning", text: "rewrite" } }, stream.emit, seen),
    ).rejects.toThrow("rewrote")
    // Codex keeps running after retry notices and warnings; only turn.failed is fatal.
    const notices = collector()
    await normalize({ type: "error", message: "Reconnecting... 2/5" }, notices.emit, seen)
    await normalize(
      { type: "item.completed", item: { id: "w", type: "error", message: "Falling back to HTTPS transport" } },
      notices.emit,
      seen,
    )
    expect(notices.events).toEqual([
      { type: "diagnostic", name: "error" },
      { type: "diagnostic", name: "error" },
    ])
    await expect(normalize({ type: "turn.failed", error: { message: "failed" } }, stream.emit, seen)).rejects.toThrow(
      "failed",
    )
  })

  test("Codex surfaces the run's own failure instead of an unreadable checkpoint, and still fails a completed run on one", async () => {
    await using dir = await tmpdir()
    // Stands in for the installed CLI: exec streams JSONL, and app-server reports the empty rollout left by a dead run.
    await Bun.write(
      path.join(dir.path, "codex"),
      `#!${process.execPath}
const write = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
if (process.argv[2] === "app-server") {
  for await (const line of console) {
    const message = JSON.parse(line)
    if (message.id === undefined) continue
    if (message.method === "initialize") write({ id: message.id, result: {} })
    else write({ id: message.id, error: { code: -32603, message: "failed to read thread: rollout at /fake is empty" } })
  }
} else {
  const prompt = await Bun.stdin.text()
  write({ type: "thread.started", thread_id: "fake-thread" })
  if (prompt.includes("crash")) {
    console.error("original exec failure")
    process.exit(1)
  }
  write({ type: "error", message: "Reconnecting... 2/5" })
  write({ type: "item.completed", item: { id: "w", type: "error", message: "warning" } })
  write({ type: "turn.started" })
  write({ type: "item.completed", item: { id: "a", type: "agent_message", text: "done" } })
  write({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } })
}
`,
    )
    await chmod(path.join(dir.path, "codex"), 0o755)
    const previous = process.env.PATH
    process.env.PATH = dir.path + path.delimiter + previous
    try {
      const run = async (message: string) => {
        const stream = collector()
        const calls = { linked: [] as string[], checkpointed: [] as string[] }
        const error = await Effect.runPromise(
          Effect.flip(
            ExternalAgentDriver.execute(CodexDriver, {
              directory: dir.path,
              model: "fixture",
              history: [],
              message: [{ type: "text", text: message }],
              harness: { type: "native" },
              gateway: ExternalAgentGateway.make([]),
              emit: stream.emit,
              linked: async (id) => {
                calls.linked.push(id)
              },
              checkpointed: async (checkpoint) => {
                calls.checkpointed.push(checkpoint)
              },
              next: async () => undefined,
              idle: () => {},
            }),
          ),
        )
        return { error: error.message, calls, events: stream.events }
      }
      const crashed = await run("crash")
      expect(crashed.error).toContain("original exec failure")
      expect(crashed.error).not.toContain("is empty")
      expect(crashed.calls).toEqual({ linked: ["fake-thread"], checkpointed: [] })
      const completed = await run("finish")
      expect(completed.events).toContainEqual({ type: "text", id: "1:a", delta: "done" })
      expect(completed.events.filter((event) => event.type === "diagnostic")).toHaveLength(2)
      expect(completed.error).toContain("is empty")
      expect(completed.calls.checkpointed).toEqual([])
    } finally {
      process.env.PATH = previous
    }
  })

  test("Codex runs the OC++ harness turn by turn through exec and exec resume", async () => {
    await using dir = await tmpdir()
    const record = path.join(dir.path, "invocations.jsonl")
    // Records each exec invocation with the instructions file it was given, then answers one turn.
    await Bun.write(
      path.join(dir.path, "codex"),
      `#!${process.execPath}
const fs = require("node:fs")
const write = (value) => process.stdout.write(JSON.stringify(value) + "\\n")
if (process.argv[2] === "app-server") {
  for await (const line of console) {
    const message = JSON.parse(line)
    if (message.id === undefined) continue
    if (message.method === "initialize") write({ id: message.id, result: {} })
    else if (message.method === "thread/resume")
      write({ id: message.id, result: { thread: { id: "fake-thread", historyMode: "legacy", turns: [] } } })
    else write({ id: message.id, result: { thread: { id: "fake-thread", historyMode: "legacy", turns: [{ id: "t" }] } } })
  }
} else if (process.argv[2] === "debug") {
  if (process.env.FAKE_CODEX_CATALOG_FAILS) process.exit(3)
  write({ models: [{ slug: "gpt-5.6-sol", tool_mode: "code_mode_only", multi_agent_version: "v2", supports_search_tool: true }] })
} else if (process.argv[2] === "mcp") {
  write([{ name: "personal", enabled: true }, { name: "ocpp", enabled: true }])
} else {
  const args = process.argv.slice(2)
  const read = (key) => {
    const file = args.map((arg) => new RegExp("^" + key + '="(.*)"$').exec(arg)?.[1]).find(Boolean)
    return file && fs.readFileSync(file, "utf8")
  }
  const prompt = await Bun.stdin.text()
  fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, prompt, token: process.env.OCPP_MCP_BEARER_TOKEN, instructions: read("model_instructions_file"), catalog: read("model_catalog_json") }) + "\\n")
  write({ type: "thread.started", thread_id: "fake-thread" })
  write({ type: "turn.started" })
  write({ type: "item.completed", item: { id: "a" + args.length, type: "agent_message", text: "answered " + prompt } })
  write({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } })
}
`,
    )
    await chmod(path.join(dir.path, "codex"), 0o755)
    // The run's instructions directory is created under TMPDIR, which must be empty again after every run.
    const temporary = path.join(dir.path, "tmp")
    await mkdir(temporary)
    const previous = { path: process.env.PATH, tmpdir: process.env.TMPDIR }
    process.env.PATH = dir.path + path.delimiter + previous.path
    process.env.TMPDIR = temporary
    try {
      const stream = collector()
      const queue = [[{ type: "text" as const, text: "Execution exe_1 saved notebook values: total." }]]
      const idles: number[] = []
      const checkpoints: string[] = []
      const options = {
        directory: dir.path,
        model: "gpt-5.6-sol",
        history: [],
        message: [{ type: "text" as const, text: "Add numbers" }],
        harness: { type: "ocpp" as const, system: "OC++ system prompt for Codex" },
        gateway: ExternalAgentGateway.make([]),
        emit: stream.emit,
        linked: async () => {},
        checkpointed: async (checkpoint: string) => {
          checkpoints.push(checkpoint)
        },
        next: async () => queue.shift(),
        idle: () => {
          idles.push(Date.now())
        },
      }
      await Effect.runPromise(ExternalAgentDriver.execute(CodexDriver, options))
      expect(await readdir(temporary)).toEqual([])
      const invocations = (await Bun.file(record).text())
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              args: string[]
              prompt: string
              token?: string
              instructions?: string
              catalog?: string
            },
        )
      expect(invocations).toHaveLength(2)
      expect(invocations.map((item) => item.prompt)).toEqual([
        "Add numbers",
        "Execution exe_1 saved notebook values: total.",
      ])
      expect(invocations[1].args.slice(-2)).toEqual(["resume", "fake-thread"])
      for (const invocation of invocations) {
        expect(invocation.instructions).toBe("OC++ system prompt for Codex")
        // The catalog stops Codex from wrapping tools in its own code mode, sub-agents and deferred search.
        expect(JSON.parse(invocation.catalog!)).toEqual({
          models: [{ slug: "gpt-5.6-sol", supports_search_tool: false }],
        })
        expect(invocation.args).toEqual(
          expect.arrayContaining([
            "features.shell_tool=false",
            "features.unified_exec=false",
            "features.multi_agent=false",
            "read-only",
            'web_search="disabled"',
            'approval_policy="on-request"',
            'mcp_servers.ocpp.default_tools_approval_mode="approve"',
            // The user's own MCP servers stay off in the OC++ harness.
            "mcp_servers.personal.enabled=false",
            'mcp_servers.ocpp.bearer_token_env_var="OCPP_MCP_BEARER_TOKEN"',
          ]),
        )
        // The bridge credential reaches Codex only through its environment.
        expect(invocation.token).toMatch(/^[0-9a-f]{64}$/)
        expect(invocation.args.join(" ")).not.toContain(String(invocation.token))
      }
      expect(idles).toHaveLength(2)
      expect(checkpoints).toHaveLength(1)
      expect(
        stream.events.filter((event) => event.type === "text").map((event) => event.type === "text" && event.delta),
      ).toEqual(["answered Add numbers", "answered Execution exe_1 saved notebook values: total."])

      // A run that fails while preparing still removes its instructions directory and closes its bridge.
      process.env.FAKE_CODEX_CATALOG_FAILS = "1"
      expect((await Effect.runPromise(Effect.exit(ExternalAgentDriver.execute(CodexDriver, options))))._tag).toBe(
        "Failure",
      )
      expect(await readdir(temporary)).toEqual([])
    } finally {
      process.env.PATH = previous.path
      if (previous.tmpdir === undefined) delete process.env.TMPDIR
      if (previous.tmpdir !== undefined) process.env.TMPDIR = previous.tmpdir
      delete process.env.FAKE_CODEX_CATALOG_FAILS
    }
  })

  test("Pi uses its installed durable SessionManager for exact history and missing-session detection", async () => {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent")
    await using dir = await tmpdir()
    const manager = SessionManager.create(dir.path)
    const signal = new AbortController().signal
    expect(await PiDriver.inspect(dir.path, crypto.randomUUID(), signal)).toBeUndefined()
    manager.appendMessage({ role: "user", content: "first", timestamp: 1 })
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: "fixture",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 2,
    })
    const initial = await PiDriver.inspect(dir.path, manager.getSessionId(), signal)
    expect(initial).toBeString()
    expect(await PiDriver.inspect(dir.path, manager.getSessionId(), signal)).toBe(initial)
    manager.appendMessage({ role: "user", content: "divergence", timestamp: 3 })
    expect(await PiDriver.inspect(dir.path, manager.getSessionId(), signal)).not.toBe(initial)
  })

  test("Pi maps tool updates and failures without exposing unknown payloads", async () => {
    const { normalize } = await import("../src/external-agent/pi.node")
    const stream = collector()
    await normalize(
      { type: "tool_execution_start", toolCallId: "t", toolName: "read", args: { path: "file" } },
      stream.emit,
    )
    await normalize(
      {
        type: "tool_execution_update",
        toolCallId: "t",
        toolName: "read",
        args: {},
        partialResult: { content: [{ type: "text", text: "partial" }] },
      },
      stream.emit,
    )
    await normalize(
      {
        type: "tool_execution_end",
        toolCallId: "t",
        toolName: "read",
        result: { content: [{ type: "text", text: "denied" }] },
        isError: true,
      },
      stream.emit,
    )
    await normalize({ type: "agent_start" }, stream.emit)
    expect(stream.events.map((event) => event.type)).toEqual(["tool-start", "tool-progress", "tool-end", "diagnostic"])
    expect(stream.events[2]).toHaveProperty("error", true)
  })

  test("interruption waits for asynchronous SDK cleanup before settling the drain", async () => {
    const gateway = ExternalAgentGateway.make([])
    const started = Promise.withResolvers<void>()
    const cleanup = Promise.withResolvers<void>()
    const stopped = Promise.withResolvers<void>()
    const driver: ExternalAgentDriver.Driver = {
      provider: "pi",
      inspect: async () => undefined,
      run: async (options) => {
        started.resolve()
        await new Promise<void>((resolve) =>
          options.signal.addEventListener(
            "abort",
            () => {
              stopped.resolve()
              resolve()
            },
            { once: true },
          ),
        )
        await cleanup.promise
      },
    }
    const fiber = Effect.runFork(
      ExternalAgentDriver.execute(driver, {
        directory: "/tmp",
        model: "fixture",
        history: [],
        message: [{ type: "text", text: "wait" }],
        harness: { type: "ocpp", system: "" },
        gateway,
        emit: async () => {},
        linked: async () => {},
        checkpointed: async () => {},
        next: async () => undefined,
        idle: () => {},
      }),
    )
    await started.promise
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber))
    await stopped.promise
    expect(fiber.pollUnsafe()).toBeUndefined()
    cleanup.resolve()
    await interrupted
    expect(fiber.pollUnsafe()).toBeDefined()
  })
})

test("Codex loads exact persisted history, pages all items and does not mistake transport errors for missing sessions", async () => {
  const { CodexHistory } = await import("../src/external-agent/codex-history.node")
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const request = async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params })
    if (method === "thread/resume") return { thread: { id: "exact", historyMode: "paginated", turns: [] } }
    if (params.cursor === null) return { data: [{ id: "first", items: ["one"] }], nextCursor: "next" }
    return { data: [{ id: "second", items: ["two"] }], nextCursor: null }
  }
  const first = await CodexHistory.inspect("exact", request)
  expect(first).toBeString()
  expect(calls).toEqual([
    {
      method: "thread/resume",
      params: {
        threadId: "exact",
        excludeTurns: true,
        sandbox: "read-only",
        approvalPolicy: "never",
        config: { sandbox_workspace_write: { network_access: false } },
      },
    },
    {
      method: "thread/turns/list",
      params: { threadId: "exact", cursor: null, limit: 100, sortDirection: "asc", itemsView: "full" },
    },
    {
      method: "thread/turns/list",
      params: { threadId: "exact", cursor: "next", limit: 100, sortDirection: "asc", itemsView: "full" },
    },
  ])
  expect(await CodexHistory.inspect("exact", request)).toBe(first)
  expect(
    await CodexHistory.inspect("missing", async () => {
      throw { code: -32600, message: "no rollout found for thread id missing" }
    }),
  ).toBeUndefined()
  await expect(
    CodexHistory.inspect("exact", async () => {
      throw new Error("database unavailable")
    }),
  ).rejects.toThrow("database unavailable")
})

test("workerd excludes every native provider without loading an SDK runtime", async () => {
  const { available, driver } = await import("../src/external-agent/platform.workerd")
  for (const provider of ["claude", "codex", "pi"] as const) {
    expect(await available(provider)).toBe(false)
    await expect(driver(provider)).rejects.toThrow("local Node or Bun")
  }
})

test("vendor retries and compaction are normalized as status without inventing transcript text", async () => {
  const { normalize } = await import("../src/external-agent/pi.node")
  const stream = collector()
  await normalize({ type: "compaction_start", reason: "threshold" }, stream.emit)
  await normalize(
    { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 20, errorMessage: "retry" },
    stream.emit,
  )
  await normalize({ type: "auto_retry_end", attempt: 1, success: true }, stream.emit)
  expect(stream.events).toEqual([
    { type: "status", status: "compacting" },
    { type: "status", status: "retrying", attempt: 1 },
    { type: "status", status: "running" },
  ])
})

test("Claude accounts for auxiliary usage without double-counting streamed tokens and retains text-only results", async () => {
  const stream = collector()
  const event = {
    type: "result" as const,
    subtype: "success" as const,
    uuid: crypto.randomUUID(),
    session_id: "claude",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: "final answer",
    stop_reason: "end_turn",
    total_cost_usd: 0.1,
    permission_denials: [],
    usage: {
      input_tokens: 5,
      output_tokens: 3,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1,
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      fallback_credit: { status: { type: "redeemed" as const } },
      inference_geo: "us",
      iterations: [],
      output_tokens_details: { thinking_tokens: 1 },
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      service_tier: "standard" as const,
      speed: "standard" as const,
    },
    modelUsage: {
      fixture: {
        inputTokens: 5,
        outputTokens: 3,
        thinkingTokens: 1,
        cacheReadInputTokens: 1,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0.1,
        contextWindow: 200_000,
        maxOutputTokens: 1000,
      },
    },
  }
  await normalize(event, stream.emit, {
    outputTokens: 1,
    textSeen: true,
    usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0 },
  })
  expect(stream.events).toEqual([
    { type: "usage", input: 3, output: 2, cacheRead: 1, cacheWrite: 0, reasoning: 1, cost: 0.1 },
    { type: "step-end" },
  ])
  const fallback = collector()
  await normalize(event, fallback.emit, { outputTokens: 0 })
  expect(fallback.events).toContainEqual({ type: "text", id: "result", delta: "final answer" })
})

test("the MCP bridge admits only its bearer token and no browser origin", async () => {
  const gateway = ExternalAgentGateway.make([
    {
      name: "echo",
      description: "Echo",
      inputSchema: { type: "object", properties: { value: { type: "string" } } },
      invoke: (input) => Effect.succeed(String(input.value)),
    },
  ])
  const bridge = await ExternalAgentBridge.open(gateway, new AbortController().signal)
  const client = new Client({ name: "bridge-test", version: "1" })
  try {
    const request = (headers: Record<string, string>) =>
      fetch(bridge.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      }).then((response) => response.status)
    expect(await request({})).toBe(401)
    expect(await request({ Authorization: "Bearer wrong" })).toBe(401)
    expect(await request({ Authorization: "Bearer " + bridge.token, Origin: "https://example.com" })).toBe(401)
    await client.connect(
      new StreamableHTTPClientTransport(new URL(bridge.url), {
        requestInit: { headers: { Authorization: "Bearer " + bridge.token } },
      }),
    )
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["echo"])
    expect((await client.callTool({ name: "echo", arguments: { value: "hi" } })).content).toEqual([
      { type: "text", text: "hi" },
    ])
  } finally {
    await client.close()
    await bridge.close()
  }
})

test("tests and OCPP_DISABLE_EXTERNAL_AGENTS never probe an installed vendor CLI", async () => {
  await using dir = await tmpdir()
  const marker = path.join(dir.path, "probed")
  for (const name of ["claude", "codex"]) {
    await Bun.write(path.join(dir.path, name), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`)
    await chmod(path.join(dir.path, name), 0o755)
  }
  const previous = process.env.PATH
  process.env.PATH = dir.path + path.delimiter + previous
  try {
    const { available } = await import("../src/external-agent/platform.node")
    expect(process.env.OCPP_DISABLE_EXTERNAL_AGENTS).toBe("true")
    expect(await Promise.all(ExternalSession.Provider.literals.map((provider) => available(provider)))).toEqual([
      false,
      false,
      false,
    ])
    expect(await Bun.file(marker).exists()).toBe(false)
  } finally {
    process.env.PATH = previous
  }
})

describe("vendor readiness probes", () => {
  it.effect("await only the first answer, then serve the last one while one background probe refreshes it", () =>
    Effect.gen(function* () {
      const answers: Array<Deferred.Deferred<boolean>> = []
      const check = Effect.suspend(() => {
        const answer = Deferred.makeUnsafe<boolean>()
        answers.push(answer)
        return Deferred.await(answer)
      })
      const probe = yield* ExternalAgentDrivers.refreshed(check, "5 minutes")
      const first = yield* Effect.forkChild(probe)
      yield* Effect.yieldNow
      yield* Deferred.succeed(answers[0], true)
      expect(yield* Fiber.join(first)).toBe(true)
      expect(yield* probe).toBe(true)
      expect(answers).toHaveLength(1)

      yield* TestClock.adjust("6 minutes")
      // The stale answer is served at once, and only one refresh starts however often it is read.
      expect(yield* probe).toBe(true)
      expect(yield* probe).toBe(true)
      yield* Effect.yieldNow
      expect(answers).toHaveLength(2)
      yield* Deferred.succeed(answers[1], false)
      yield* Effect.yieldNow
      expect(yield* probe).toBe(false)
      expect(answers).toHaveLength(2)
    }),
  )
})
