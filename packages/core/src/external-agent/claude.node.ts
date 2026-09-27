import type { McpServerConfig, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { ExternalAgentDriver } from "./driver.js"
import { ExternalAgentEffort } from "./effort.js"
import { which } from "../util/which.js"
import { ExternalAgentBridge } from "./bridge.node.js"

const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

export const ClaudeDriver: ExternalAgentDriver.Driver = {
  provider: "claude",
  async inspect(directory, id) {
    const { getSessionInfo, getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk")
    if ((await getSessionInfo(id, { dir: directory })) === undefined) return undefined
    return fingerprint(await getSessionMessages(id, { dir: directory, includeSystemMessages: true }))
  },
  async run(options) {
    const { query, createSdkMcpServer, getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk")
    const mcp = createSdkMcpServer({ name: "ocpp", version: "1", tools: [] })
    ExternalAgentBridge.handlers(mcp.instance.server, options.gateway, options.signal)
    const controller = new AbortController()
    const abort = () => controller.abort()
    options.signal.throwIfAborted()
    options.signal.addEventListener("abort", abort, { once: true })
    // Streaming input keeps one vendor turn loop per drain: steers join the running turn at its next boundary.
    const prompt = async function* (): AsyncGenerator<SDKUserMessage> {
      yield message(ExternalAgentDriver.first(options))
      while (true) {
        const next = await options.next(controller.signal).catch(() => undefined)
        if (next === undefined) return
        yield message(next)
      }
    }
    const stream = query({
      prompt: prompt(),
      options: settings(options, mcp, controller, which("claude") ?? undefined),
    })
    const state = { outputTokens: 0 }
    const identity = { id: options.vendorSessionID }
    try {
      for await (const event of stream) {
        if ("session_id" in event && event.session_id !== undefined && event.session_id !== identity.id) {
          identity.id = event.session_id
          await options.linked(event.session_id)
        }
        await normalize(event, options.emit, state)
        if (event.type === "result") options.idle()
      }
      options.signal.throwIfAborted()
      if (identity.id === undefined) throw new Error("Claude returned no session ID")
    } finally {
      options.signal.removeEventListener("abort", abort)
      controller.abort()
      stream.close()
      await mcp.instance.close()
      if (identity.id !== undefined)
        await options.checkpointed(
          fingerprint(await getSessionMessages(identity.id, { dir: options.directory, includeSystemMessages: true })),
        )
    }
  },
}

function message(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, priority: "next" }
}

/** Vendor options for one run. The OC++ harness keeps nothing of Claude Code but its model loop and OC++'s execute. */
export function settings(
  options: Pick<
    ExternalAgentDriver.Options,
    "directory" | "model" | "effort" | "vendorSessionID" | "harness" | "authorize"
  >,
  mcp: McpServerConfig,
  controller: AbortController,
  executable?: string,
): Options {
  const common = {
    pathToClaudeCodeExecutable: executable,
    cwd: options.directory,
    model: options.model,
    effort:
      options.effort === undefined ? undefined : Schema.decodeUnknownSync(ExternalAgentEffort.claude)(options.effort),
    resume: options.vendorSessionID,
    abortController: controller,
    includePartialMessages: true,
    mcpServers: { ocpp: mcp },
  } satisfies Options
  if (options.harness.type === "ocpp")
    return {
      ...common,
      systemPrompt: options.harness.system,
      tools: [],
      settingSources: [],
      strictMcpConfig: true,
      skills: [],
      allowedTools: ["mcp__ocpp__execute"],
      // Nothing else may run, and there is nobody to ask.
      permissionMode: "dontAsk",
    }
  return {
    ...common,
    settingSources: ["user", "project", "local"],
    permissionMode: "default",
    sandbox: { enabled: true, allowUnsandboxedCommands: false, autoAllowBashIfSandboxed: false },
    ...permissionHooks(options.authorize),
  }
}

export async function normalize(
  event: SDKMessage,
  emit: ExternalAgentDriver.Options["emit"],
  state: {
    outputTokens: number
    textSeen?: boolean
    usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
  },
) {
  const usage = (state.usage ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
  if (event.type === "stream_event") {
    const update = event.event
    if (update.type === "message_start") {
      state.outputTokens = 0
      state.textSeen = false
      usage.input += update.message.usage.input_tokens
      usage.cacheRead += update.message.usage.cache_read_input_tokens ?? 0
      usage.cacheWrite += update.message.usage.cache_creation_input_tokens ?? 0
      await emit({ type: "step-start", id: update.message.id })
      await emit({
        type: "usage",
        input: update.message.usage.input_tokens,
        output: 0,
        cacheRead: update.message.usage.cache_read_input_tokens ?? 0,
        cacheWrite: update.message.usage.cache_creation_input_tokens ?? 0,
      })
      return
    }
    if (update.type === "content_block_delta") {
      if (update.delta.type === "text_delta") {
        state.textSeen = true
        await emit({ type: "text", id: String(update.index), delta: update.delta.text })
      }
      if (update.delta.type === "thinking_delta")
        await emit({ type: "reasoning", id: String(update.index), delta: update.delta.thinking })
      return
    }
    if (update.type === "message_delta") {
      usage.output += update.usage.output_tokens - state.outputTokens
      await emit({ type: "usage", input: 0, output: update.usage.output_tokens - state.outputTokens, cacheRead: 0 })
      state.outputTokens = update.usage.output_tokens
    }
    return
  }
  if (event.type === "assistant") {
    if (event.error) await emit({ type: "diagnostic", name: "assistant.error:" + event.error })
    for (const block of event.message.content)
      if (block.type === "tool_use") {
        await emit({
          type: "tool-start",
          id: block.id,
          name: block.name,
          input: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(block.input),
        })
      }
    return
  }
  if (event.type === "user") {
    if (!Array.isArray(event.message.content)) return
    for (const block of event.message.content)
      if (block.type === "tool_result") {
        await emit({
          type: "tool-end",
          id: block.tool_use_id,
          output: typeof block.content === "string" ? block.content : (JSON.stringify(block.content) ?? "Completed."),
          error: block.is_error,
        })
      }
    return
  }
  if (event.type === "system" && event.subtype === "status") {
    await emit({ type: "status", status: event.status === "compacting" ? "compacting" : "running" })
    return
  }
  if (event.type === "system" && event.subtype === "api_retry") {
    await emit({ type: "status", status: "retrying", attempt: event.attempt })
    return
  }
  if (event.type === "tool_progress") {
    await emit({ type: "tool-progress", id: event.tool_use_id, metadata: { elapsed: event.elapsed_time_seconds } })
    return
  }
  if (event.type === "system" && event.subtype === "permission_denied") {
    await emit({ type: "tool-end", id: event.tool_use_id, output: event.message, error: true })
    return
  }
  if (event.type === "result") {
    const models = Object.values(event.modelUsage)
    const totals =
      models.length === 0
        ? {
            input: event.usage.input_tokens,
            output: event.usage.output_tokens,
            cacheRead: event.usage.cache_read_input_tokens,
            cacheWrite: event.usage.cache_creation_input_tokens,
            reasoning: 0,
          }
        : models.reduce(
            (total, model) => ({
              input: total.input + model.inputTokens,
              output: total.output + model.outputTokens,
              cacheRead: total.cacheRead + model.cacheReadInputTokens,
              cacheWrite: total.cacheWrite + model.cacheCreationInputTokens,
              reasoning: total.reasoning + (model.thinkingTokens ?? 0),
            }),
            { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
          )
    // The SDK's model totals include auxiliary calls such as compaction. Add only usage not already streamed.
    await emit({
      type: "usage",
      input: Math.max(0, totals.input - usage.input),
      output: Math.max(0, totals.output - usage.output),
      cacheRead: Math.max(0, totals.cacheRead - usage.cacheRead),
      cacheWrite: Math.max(0, totals.cacheWrite - usage.cacheWrite),
      reasoning: totals.reasoning,
      cost: event.total_cost_usd,
    })
    if (event.subtype !== "success") throw new Error(event.errors.join("\n"))
    if (event.is_error) throw new Error(event.result)
    if (!state.textSeen && event.result) await emit({ type: "text", id: "result", delta: event.result })
    await emit({ type: "step-end" })
    return
  }
  await emit({ type: "diagnostic", name: event.type + ("subtype" in event ? ":" + event.subtype : "") })
}

/** Hook failures must return a denial: vendor hook exceptions are not an authorization decision. */
export function permissionHooks(
  check: ExternalAgentDriver.Options["authorize"],
): Pick<Options, "hooks" | "canUseTool"> {
  const authorized = new Map<string, { fingerprint: string; cwd: string }>()
  // The in-process `ocpp` server's tools are OC++'s own: execute enforces permissions inside, and tool.define handles
  // and submit_result are capabilities the subagent call delegated.
  const authorize: ExternalAgentDriver.Options["authorize"] = (name, ...rest) =>
    name.startsWith("mcp__ocpp__") ? Promise.resolve() : check(name, ...rest)
  return {
    hooks: {
      PreToolUse: [
        {
          hooks: [
            async (event, id, hook) => {
              if (event.hook_event_name !== "PreToolUse") return {}
              const input = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(event.tool_input)
              return authorize(event.tool_name, input, hook.signal, id, event.cwd).then(
                () => {
                  if (id !== undefined)
                    authorized.set(id, { fingerprint: fingerprint({ name: event.tool_name, input }), cwd: event.cwd })
                  // No permissionDecision: vendor deny/ask rules and sandbox still run.
                  return {}
                },
                (error: unknown) => ({
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "deny" as const,
                    permissionDecisionReason: String(error),
                  },
                }),
              )
            },
          ],
        },
      ],
    },
    canUseTool: async (name, input, request) => {
      const previous = authorized.get(request.toolUseID)
      authorized.delete(request.toolUseID)
      const allowed =
        previous?.fingerprint === fingerprint({ name, input })
          ? Promise.resolve()
          : authorize(name, input, request.signal, request.toolUseID, previous?.cwd)
      return allowed.then(
        () => ({ behavior: "allow" as const, updatedInput: input }),
        (error: unknown) => ({ behavior: "deny" as const, message: String(error) }),
      )
    },
  }
}
