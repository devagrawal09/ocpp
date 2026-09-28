import type { AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent"
import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { ExternalAgentDriver } from "./driver.js"
import { ExternalAgentEffort } from "./effort.js"

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
    const loader = new DefaultResourceLoader(
      options.harness.type === "ocpp"
        ? {
            cwd: options.directory,
            agentDir: getAgentDir(),
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            systemPrompt: options.harness.system,
          }
        : // The native harness keeps Pi's own tools, extensions and settings; OC++ does not authorize its calls.
          { cwd: options.directory, agentDir: getAgentDir() },
    )
    await loader.reload()
    const tools: ToolDefinition[] = options.gateway.definitions.map((tool) => ({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as ToolDefinition["parameters"],
      executionMode: "sequential",
      async execute(id, input, signal) {
        const result = await Effect.runPromise(Effect.result(options.gateway.invoke(tool.name, input, id)), {
          signal: signal ?? options.signal,
        })
        if (result._tag === "Failure") throw new Error(result.failure)
        return { content: [{ type: "text", text: result.success }], details: {} }
      },
    }))
    const result = await createAgentSession({
      cwd: options.directory,
      modelRuntime: runtime,
      model,
      thinkingLevel:
        options.effort === undefined ? undefined : Schema.decodeUnknownSync(ExternalAgentEffort.pi)(options.effort),
      sessionManager: manager,
      resourceLoader: loader,
      customTools: tools,
      // The OC++ harness keeps Pi's model loop and OC++'s execute, never Pi's read, bash, edit or write.
      ...(options.harness.type === "ocpp" ? { noTools: "builtin" as const } : {}),
    })
    await result.session.bindExtensions({})
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
      const turn = { message: ExternalAgentDriver.first(options) as string | undefined }
      // Input waits for the end of each prompt, like Codex.
      while (turn.message !== undefined) {
        await result.session.prompt(turn.message)
        await queue.pending
        options.signal.throwIfAborted()
        options.idle()
        turn.message = await options.next(options.signal)
      }
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
