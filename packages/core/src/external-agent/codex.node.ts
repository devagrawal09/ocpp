import type { CodexOptions, ModelReasoningEffort, ThreadEvent, ThreadOptions } from "@openai/codex-sdk"
import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Schema } from "effect"
import { ExternalAgentDriver } from "./driver.js"
import { ExternalAgentEffort } from "./effort.js"
import { ExternalAgentBridge } from "./bridge.node.js"
import { CodexHistory } from "./codex-history.node.js"

/** Every Codex capability that is a model-facing tool or a vendor instruction source, off in the OC++ harness. */
export const NATIVE_FEATURES = [
  "shell_tool",
  "unified_exec",
  "multi_agent",
  "multi_agent_v2",
  "view_image",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "in_app_browser",
  "computer_use",
  "image_generation",
  "apps",
  "plugins",
  "remote_plugin",
  "sleep_tool",
  "tool_suggest",
  "skill_search",
  "skill_mcp_dependency_install",
  "code_mode",
  "code_mode_host",
  "code_mode_only",
  "goals",
  "memories",
  "hooks",
  "standalone_web_search",
  "request_permissions_tool",
]

export const CodexDriver: ExternalAgentDriver.Driver = {
  provider: "codex",
  inspect: (_directory, id, signal) => CodexHistory.read(id, signal),
  async run(options) {
    const { Codex } = await import("@openai/codex-sdk")
    const bridge = await ExternalAgentBridge.open(options.gateway, options.signal)
    const instructions = options.harness.type === "ocpp" ? await mkdtemp(path.join(tmpdir(), "ocpp-codex-")) : undefined
    const identity = { id: options.vendorSessionID, completed: false }
    try {
      options.signal.throwIfAborted()
      if (options.harness.type === "native")
        // Codex exec has no approval callback: authorize the bounded workspace delegation in OC++ and
        // keep its sandbox enabled. On-request permits configured MCP tools while unsandboxed escalation still fails.
        await options.authorize("workspace", {
          directory: options.directory,
          sandbox: "workspace-write",
          network: false,
        })
      if (instructions !== undefined && options.harness.type === "ocpp") {
        await writeFile(path.join(instructions, "instructions.md"), options.harness.system)
        await writeFile(path.join(instructions, "catalog.json"), await catalog(options.signal))
      }
      const settings = configure(options, bridge, instructions)
      const codex = new Codex({
        apiKey: process.env.CODEX_API_KEY ?? process.env.OPENAI_API_KEY,
        codexPathOverride: "codex",
        config: settings.config,
      })
      const thread =
        options.vendorSessionID === undefined
          ? codex.startThread(settings.thread)
          : codex.resumeThread(options.vendorSessionID, settings.thread)
      const turn = { message: ExternalAgentDriver.first(options) as string | undefined, count: 0 }
      // Codex's exec SDK takes input only between turns, so steers and notifications wait for the turn to end.
      while (turn.message !== undefined) {
        const stream = await thread.runStreamed(turn.message, { signal: options.signal })
        // Each exec invocation numbers its items from zero again.
        const prefix = `${++turn.count}:`
        const seen = new Map<string, string>()
        for await (const event of stream.events) {
          if (event.type === "thread.started") {
            identity.id = event.thread_id
            await options.linked(event.thread_id)
            continue
          }
          await normalize(
            event,
            (item) =>
              options.emit("id" in item && item.type !== "step-start" ? { ...item, id: prefix + item.id } : item),
            seen,
          )
          // Drain the SDK completion: its aggregate usage is emitted only at the terminal boundary.
        }
        if (thread.id === null) throw new Error("Codex returned no thread ID")
        options.idle()
        turn.message = await options.next(options.signal)
      }
      identity.completed = true
    } finally {
      await bridge.close()
      if (instructions !== undefined) await rm(instructions, { recursive: true, force: true })
      if (identity.id !== undefined) {
        // A run that fails or is interrupted before its first turn leaves an empty, unreadable rollout. That read
        // error must not replace the run's own error. No checkpoint is recorded, so the next resume rebuilds.
        const checkpoint = await CodexHistory.read(identity.id, AbortSignal.timeout(30_000)).catch((error: unknown) => {
          if (identity.completed) throw error
          return undefined
        })
        if (checkpoint !== undefined) await options.checkpointed(checkpoint)
      }
    }
  },
}

/**
 * Codex's own model catalog with the per-model switches that force its JavaScript code mode, its sub-agent tools and
 * deferred tool search turned off, so OC++'s execute is offered to the model directly.
 */
async function catalog(signal: AbortSignal) {
  const output = await new Promise<string>((resolve, reject) =>
    execFile("codex", ["debug", "models"], { signal, timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    ),
  )
  const parsed = Schema.decodeUnknownSync(Catalog)(output)
  return JSON.stringify({
    ...parsed,
    models: parsed.models.map((model) => ({
      ...Object.fromEntries(
        Object.entries(model).filter(([key]) => key !== "tool_mode" && key !== "multi_agent_version"),
      ),
      supports_search_tool: false,
    })),
  })
}
const Catalog = Schema.fromJsonString(
  Schema.StructWithRest(Schema.Struct({ models: Schema.Array(Schema.Record(Schema.String, Schema.Json)) }), [
    Schema.Record(Schema.String, Schema.Json),
  ]),
)

/** Codex configuration for one run. `workspace` holds the OC++ system prompt and model catalog in the OC++ harness. */
export function configure(
  options: Pick<ExternalAgentDriver.Options, "directory" | "model" | "effort" | "harness">,
  bridge: { readonly url: string; readonly token: string },
  workspace?: string,
): { readonly config: NonNullable<CodexOptions["config"]>; readonly thread: ThreadOptions } {
  const mcp = {
    ocpp: {
      url: bridge.url,
      http_headers: { Authorization: "Bearer " + bridge.token },
      // Codex exec cannot ask anyone, so OC++'s tools are approved here and OC++ authorizes each one itself.
      default_tools_approval_mode: "approve",
    },
  }
  const effort: ModelReasoningEffort | undefined =
    options.effort === undefined ? undefined : Schema.decodeUnknownSync(ExternalAgentEffort.codex)(options.effort)
  const common = {
    model: options.model,
    workingDirectory: options.directory,
    skipGitRepoCheck: true,
    // On-request lets the OC++ MCP server run while every sandbox escalation fails in exec mode.
    approvalPolicy: "on-request",
    networkAccessEnabled: false,
    modelReasoningEffort: effort,
  } satisfies ThreadOptions
  if (options.harness.type === "native")
    return {
      config: { features: { multi_agent: true }, mcp_servers: mcp },
      thread: { ...common, sandboxMode: "workspace-write", webSearchMode: "live" } satisfies ThreadOptions,
    }
  return {
    config: {
      features: Object.fromEntries(NATIVE_FEATURES.map((feature) => [feature, false])),
      ...(workspace === undefined
        ? {}
        : {
            model_instructions_file: path.join(workspace, "instructions.md"),
            model_catalog_json: path.join(workspace, "catalog.json"),
          }),
      include_apps_instructions: false,
      include_permissions_instructions: false,
      include_environment_context: false,
      include_collaboration_mode_instructions: false,
      skills: { include_instructions: false, bundled: { enabled: false } },
      mcp_servers: mcp,
    },
    // The patch tool cannot be switched off, so a read-only sandbox makes every native write fail.
    thread: { ...common, sandboxMode: "read-only", webSearchMode: "disabled" } satisfies ThreadOptions,
  }
}

export async function normalize(
  event: ThreadEvent,
  emit: ExternalAgentDriver.Options["emit"],
  seen: Map<string, string>,
) {
  if (event.type === "turn.started") {
    await emit({ type: "step-start", id: "codex" })
    return
  }
  if (event.type === "turn.completed") {
    await emit({
      type: "usage",
      input: event.usage.input_tokens,
      output: event.usage.output_tokens,
      cacheRead: event.usage.cached_input_tokens,
      cacheWrite: event.usage.cache_write_input_tokens,
      reasoning: event.usage.reasoning_output_tokens,
    })
    await emit({ type: "step-end" })
    return
  }
  // Codex reports recoverable notices such as "Reconnecting... 2/5" as top-level errors and keeps running.
  // Throwing here kills the CLI mid-run; turn.failed and the exec exit status carry every fatal outcome.
  if (event.type === "error") {
    await emit({ type: "diagnostic", name: event.type })
    return
  }
  if (event.type === "turn.failed") throw new Error(event.error.message)
  if (event.type === "thread.started") return
  if (!["item.started", "item.updated", "item.completed"].includes(event.type)) {
    await emit({ type: "diagnostic", name: event.type })
    return
  }
  const item = event.item
  if (
    ![
      "agent_message",
      "reasoning",
      "error",
      "todo_list",
      "command_execution",
      "file_change",
      "mcp_tool_call",
      "web_search",
    ].includes(item.type)
  ) {
    await emit({ type: "diagnostic", name: item.type })
    return
  }
  if (item.type === "agent_message" || item.type === "reasoning") {
    const previous = seen.get(item.id) ?? ""
    if (!item.text.startsWith(previous)) throw new Error("Codex rewrote an already-projected message")
    const delta = item.text.slice(previous.length)
    seen.set(item.id, item.text)
    if (delta) await emit({ type: item.type === "reasoning" ? "reasoning" : "text", id: item.id, delta })
    return
  }
  // Error items are Codex warnings (the SDK documents them as non-fatal), not run failures.
  if (item.type === "error" || item.type === "todo_list") {
    await emit({ type: "diagnostic", name: item.type })
    return
  }
  const input =
    item.type === "mcp_tool_call"
      ? Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(item.arguments)
      : item.type === "command_execution"
        ? { command: item.command }
        : item.type === "file_change"
          ? { changes: item.changes }
          : { query: item.query }
  await emit({
    type: "tool-start",
    id: item.id,
    name: item.type === "mcp_tool_call" ? `mcp__${item.server}__${item.tool}` : item.type,
    input,
  })
  if (event.type !== "item.completed") {
    if (item.type === "command_execution")
      await emit({ type: "tool-progress", id: item.id, metadata: { output: item.aggregated_output } })
    return
  }
  const output =
    item.type === "command_execution"
      ? item.aggregated_output
      : item.type === "mcp_tool_call"
        ? (item.error?.message ?? JSON.stringify(item.result?.content ?? []))
        : JSON.stringify(input)
  await emit({ type: "tool-end", id: item.id, output, error: "status" in item && item.status === "failed" })
}
