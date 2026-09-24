import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { ExternalAgentDriver } from "./driver.js"

const Effort = Schema.Literals(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

export const PiDriver: ExternalAgentDriver.Driver = {
  provider: "pi",
  async inspect(directory, id) {
    const { SessionManager } = await import("@earendil-works/pi-coding-agent")
    const previous = (await SessionManager.list(directory)).find((item) => item.id === id)
    return previous === undefined
      ? undefined
      : fingerprint(SessionManager.open(previous.path).buildSessionContext().messages)
  },
  async run(options) {
    const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, getAgentDir } = await import(
      "@earendil-works/pi-coding-agent"
    )
    const runtime = await ModelRuntime.create({ allowModelNetwork: false, signal: options.signal })
    const slash = options.model.indexOf("/")
    const model = runtime.getModel(options.model.slice(0, slash), options.model.slice(slash + 1))
    if (!model) throw new Error("Unknown Pi model: " + options.model)
    const previous =
      options.vendorSessionID === undefined
        ? undefined
        : (await SessionManager.list(options.directory)).find((item) => item.id === options.vendorSessionID)
    const manager =
      previous === undefined ? SessionManager.create(options.directory) : SessionManager.open(previous.path)
    if (previous === undefined && options.history.length > 0)
      manager.appendMessage({
        role: "user",
        content: "Restored canonical OC++ history:\n" + ExternalAgentDriver.replay(options.history),
        timestamp: Date.now(),
      })
    const loader = new DefaultResourceLoader({
      cwd: options.directory,
      agentDir: getAgentDir(),
      extensionFactories: [
        (api) => {
          // Keep Pi's discovered extensions and their policies. This additional guard cannot turn a vendor denial into an allow.
          api.on("tool_call", async (event, context) => {
            await options.authorize(event.toolName, event.input, options.signal, event.toolCallId, context.cwd)
          })
        },
      ],
    })
    await loader.reload()
    const tools: ToolDefinition[] = options.gateway.definitions.map((tool) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as ToolDefinition["parameters"],
      executionMode: "sequential",
      async execute(_id, input, signal) {
        const value = await Effect.runPromise(options.gateway.invoke(tool.name, input), {
          signal: signal ?? options.signal,
        })
        return {
          content: [
            { type: "text", text: typeof value === "string" ? value : (JSON.stringify(value) ?? "Completed.") },
          ],
          details: {},
        }
      },
    }))
    const result = await createAgentSession({
      cwd: options.directory,
      modelRuntime: runtime,
      model,
      thinkingLevel: options.effort === undefined ? undefined : Schema.decodeUnknownSync(Effort)(options.effort),
      sessionManager: manager,
      resourceLoader: loader,
      customTools: tools,
    })
    await result.session.bindExtensions({})
    const stop = result.session.agent.shouldStopAfterTurn
    result.session.agent.shouldStopAfterTurn = async (context, signal) =>
      options.gateway.result() !== undefined || (await stop?.(context, signal)) === true
    const queue = { pending: Promise.resolve() }
    const unsubscribe = result.session.subscribe((event) => {
      queue.pending = queue.pending.then(() => normalize(event, options.emit))
      // Observe early rejection while the SDK is still producing; the awaited queue below retains the failure.
      void queue.pending.catch(() => result.session.abort())
    })
    const abort = () => {
      void result.session.abort()
    }
    options.signal.addEventListener("abort", abort, { once: true })
    try {
      options.signal.throwIfAborted()
      await options.linked(manager.getSessionId())
      await result.session.prompt(options.message)
      await queue.pending
      options.signal.throwIfAborted()
    } finally {
      options.signal.removeEventListener("abort", abort)
      unsubscribe()
      result.session.dispose()
      await options.checkpointed(fingerprint(manager.buildSessionContext().messages))
    }
  },
}

export async function normalize(event: AgentSessionEvent, emit: ExternalAgentDriver.Options["emit"]) {
  if (event.type === "message_start" && event.message.role === "assistant") {
    await emit({ type: "step-start", id: String(event.message.timestamp) })
    return
  }
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent
    if (update.type === "text_delta" || update.type === "thinking_delta") {
      await emit({
        type: update.type === "text_delta" ? "text" : "reasoning",
        id: String(update.contentIndex),
        delta: update.delta,
      })
    }
    return
  }
  if (event.type === "message_end" && event.message.role === "assistant") {
    const usage = event.message.usage
    await emit({
      type: "usage",
      input: usage.input,
      output: usage.output,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      cost: usage.cost.total,
    })

    return
  }
  if (event.type === "agent_end" && !event.willRetry) {
    const last = event.messages.findLast((message) => message.role === "assistant")
    if (last?.role === "assistant" && (last.stopReason === "error" || last.stopReason === "aborted"))
      throw new Error(last.errorMessage ?? "Pi execution failed")
    return
  }
  if (event.type === "auto_retry_start") {
    await emit({ type: "status", status: "retrying", attempt: event.attempt })
    return
  }
  if (event.type === "auto_retry_end") {
    if (!event.success) throw new Error(event.finalError ?? "Pi retry failed")
    await emit({ type: "status", status: "running" })
    return
  }
  if (event.type === "compaction_start" || event.type === "compaction_end") {
    await emit({ type: "status", status: event.type === "compaction_start" ? "compacting" : "running" })
    return
  }
  if (event.type === "turn_end") {
    await emit({ type: "step-end" })
    return
  }
  if (event.type === "tool_execution_start") {
    await emit({
      type: "tool-start",
      id: event.toolCallId,
      name: event.toolName,
      input: Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(event.args),
    })
    return
  }
  if (event.type === "tool_execution_update") {
    await emit({
      type: "tool-progress",
      id: event.toolCallId,
      metadata: { output: JSON.stringify(event.partialResult.content) },
    })
    return
  }
  if (event.type === "tool_execution_end") {
    await emit({
      type: "tool-end",
      id: event.toolCallId,
      output: JSON.stringify(event.result.content),
      error: event.isError,
    })
    return
  }
  await emit({ type: "diagnostic", name: event.type })
}
