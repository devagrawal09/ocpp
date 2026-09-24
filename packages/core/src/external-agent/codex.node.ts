import type { ModelReasoningEffort, ThreadEvent } from "@openai/codex-sdk"
import { Schema } from "effect"
import { ExternalAgentDriver } from "./driver.js"
import { ExternalAgentBridge } from "./bridge.node.js"
import { CodexHistory } from "./codex-history.node.js"

const Effort = Schema.Literals(["minimal", "low", "medium", "high", "xhigh", "max", "ultra", "persistent"])

export const CodexDriver: ExternalAgentDriver.Driver = {
  provider: "codex",
  inspect: (_directory, id, signal) => CodexHistory.read(id, signal),
  async run(options) {
    const { Codex } = await import("@openai/codex-sdk")
    const effort: ModelReasoningEffort | undefined =
      options.effort === undefined ? undefined : Schema.decodeUnknownSync(Effort)(options.effort)
    const bridge = await ExternalAgentBridge.open(options.gateway, options.signal)
    const identity = { id: options.vendorSessionID, completed: false }
    try {
      options.signal.throwIfAborted()
      // Codex exec has no approval callback: authorize the bounded workspace delegation in OC++ and
      // keep its sandbox enabled. On-request permits configured MCP tools while unsandboxed escalation still fails.
      await options.authorize("workspace", { directory: options.directory, sandbox: "workspace-write", network: false })
      const codex = new Codex({
        apiKey: process.env.CODEX_API_KEY ?? process.env.OPENAI_API_KEY,
        codexPathOverride: "codex",
        config: {
          features: { multi_agent: true },
          mcp_servers: { ocpp: { url: bridge.url, http_headers: { Authorization: "Bearer " + bridge.token } } },
        },
      })
      const settings = {
        model: options.model,
        workingDirectory: options.directory,
        skipGitRepoCheck: true,
        sandboxMode: "workspace-write" as const,
        approvalPolicy: "on-request" as const,
        networkAccessEnabled: false,
        webSearchMode: "live" as const,
        modelReasoningEffort: effort,
      }
      const thread =
        options.vendorSessionID === undefined
          ? codex.startThread(settings)
          : codex.resumeThread(options.vendorSessionID!, settings)
      const stream = await thread.runStreamed(
        [
          options.vendorSessionID === undefined && options.history.length > 0
            ? "Restored canonical OC++ history:\n" + ExternalAgentDriver.replay(options.history)
            : "",
          options.message,
        ]
          .filter(Boolean)
          .join("\n\n"),
        { signal: options.signal },
      )
      const seen = new Map<string, string>()
      for await (const event of stream.events) {
        if (event.type === "thread.started") {
          identity.id = event.thread_id
          await options.linked(event.thread_id)
          continue
        }
        await normalize(event, options.emit, seen)
        // Drain the SDK completion: its aggregate usage is emitted only at the terminal boundary.
      }
      if (thread.id === null) throw new Error("Codex returned no thread ID")
      identity.completed = true
    } finally {
      await bridge.close()
      if (identity.id !== undefined) {
        // A run that fails or is interrupted before its first turn leaves an empty, unreadable rollout. That read
        // error must not replace the run's own error. No checkpoint is recorded, so the next resume fails closed.
        const checkpoint = await CodexHistory.read(identity.id, AbortSignal.timeout(30_000)).catch((error: unknown) => {
          if (identity.completed) throw error
          return undefined
        })
        if (checkpoint !== undefined) await options.checkpointed(checkpoint)
      }
    }
  },
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
  await emit({ type: "tool-start", id: item.id, name: item.type === "mcp_tool_call" ? item.tool : item.type, input })
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
