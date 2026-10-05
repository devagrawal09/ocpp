import type { McpServerConfig, Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { ExternalAgentDriver } from "./driver.js"
import { ExternalAgentEffort } from "./effort.js"
import { imageMimes } from "../session/runner/to-llm-message.js"
import { which } from "../util/which.js"
import { ExternalAgentBridge } from "./bridge.node.js"
import type { ExternalAgentGateway } from "./gateway.js"

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
    ExternalAgentBridge.handlers(
      mcp.instance.server,
      options.harness.type === "ocpp" ? instructions(options.gateway, options.harness.system) : options.gateway,
      options.signal,
    )
    const controller = new AbortController()
    const abort = () => controller.abort()
    options.signal.throwIfAborted()
    options.signal.addEventListener("abort", abort, { once: true })
    const state = { outputTokens: 0, inputID: crypto.randomUUID() }
    // Streaming input keeps one vendor turn loop per drain: steers join the running turn at its next boundary.
    const prompt = async function* (): AsyncGenerator<SDKUserMessage> {
      yield { ...message(ExternalAgentDriver.first(options)), uuid: state.inputID }
      while (true) {
        const next = await options.next(controller.signal).catch(() => undefined)
        if (next === undefined) return
        state.inputID = crypto.randomUUID()
        yield { ...message(next), uuid: state.inputID }
      }
    }
    const stream = query({
      prompt: prompt(),
      options: settings(options, mcp, controller, which("claude") ?? undefined),
    })
    const identity = { id: options.vendorSessionID }
    try {
      for await (const event of stream) {
        if ("session_id" in event && event.session_id !== undefined && event.session_id !== identity.id) {
          identity.id = event.session_id
          await options.linked(event.session_id)
        }
        await normalize(event, options.emit, state)
        // A result must acknowledge the newest submitted input before idle can close the MCP control channel.
        if (
          event.type === "result" &&
          !event.queued_turn_count &&
          (event.user_message_uuids ?? [event.user_message_uuid]).includes(state.inputID)
        )
          options.idle()
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

/** Input as Claude Code's streaming input takes it: images and PDFs are Anthropic content blocks beside the text. */
export function message(input: ExternalAgentDriver.Input): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: input.length === 1 && input[0].type === "text" ? input[0].text : input.map(block),
    },
    parent_tool_use_id: null,
    priority: "next",
  }
}

type Block = Exclude<SDKUserMessage["message"]["content"], string>[number]
type ImageType = Extract<Extract<Block, { type: "image" }>["source"], { type: "base64" }>["media_type"]

function block(part: ExternalAgentDriver.Input[number]): Block {
  if (part.type === "text") return part
  if (part.mime === "application/pdf")
    return {
      type: "document",
      source: { type: "base64", media_type: "application/pdf", data: part.data },
      ...(part.name === undefined ? {} : { title: part.name }),
    }
  if (isImage(part.mime)) return { type: "image", source: { type: "base64", media_type: part.mime, data: part.data } }
  return ExternalAgentDriver.omitted(part, "Claude Code takes only PNG, JPEG, GIF and WebP images and PDFs")
}

// The image types OC++ lowers to model media, which are the ones Anthropic takes.
function isImage(mime: string): mime is ImageType {
  return imageMimes.has(mime)
}

/** Keep the complete session instructions in execute's description rather than the system prompt. */
export function instructions(gateway: ExternalAgentGateway.Gateway, system: string) {
  return {
    ...gateway,
    definitions: gateway.definitions.map((tool) =>
      tool.name === "execute"
        ? { ...tool, description: `${tool.description}\n\n## Session Instructions\n${system}` }
        : tool,
    ),
  }
}

/** Vendor options for one run. The OC++ harness exposes only execute, including its session instructions. */
export function settings(
  options: Pick<ExternalAgentDriver.Options, "directory" | "model" | "effort" | "vendorSessionID" | "harness">,
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
    // Environment controls reach native subagents. Flag settings outrank user and project settings.
    env: { ...process.env, DISABLE_AUTO_COMPACT: "1", DISABLE_COMPACT: "1" },
    managedSettings: { autoCompactEnabled: false, precomputeCompactionEnabled: false },
    extraArgs: {
      settings: JSON.stringify({ autoCompactEnabled: false, precomputeCompactionEnabled: false }),
    },
  } satisfies Options
  if (options.harness.type === "ocpp")
    return {
      ...common,
      systemPrompt:
        "You are a coding assistant. Follow the session instructions in the mcp__ocpp__execute tool description. Use that tool for the supplied capabilities.",
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
    // OC++ does not authorize native calls and nobody can answer a prompt: what Claude Code would ask about runs,
    // while the user's own deny rules and its sandbox still apply.
    canUseTool: async (_name, input) => ({ behavior: "allow", updatedInput: input }),
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
