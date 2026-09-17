export * as ExternalAgentStream from "./stream.js"

import { Money } from "@opencode-ai/schema/money"
import type { Agent } from "@opencode-ai/schema/agent"
import type { Model } from "@opencode-ai/schema/model"
import type { Session } from "@opencode-ai/schema/session"
import { Effect } from "effect"
import { Bus } from "../bus.js"
import { SessionEvent } from "../session/event.js"
import { SessionMessage } from "../session/message.js"
import { toSessionError } from "../session/to-session-error.js"
import type { ExternalAgentDriver } from "./driver.js"

/** Vendor fragments are ephemeral; only final blocks and tool settlements enter durable history. */
export function make(
  bus: Bus.Interface,
  sessionID: Session.ID,
  agent: Agent.ID,
  model: Model.Ref,
  progress: (event: Extract<ExternalAgentDriver.Event, { type: "status" }>) => Effect.Effect<void> = () => Effect.void,
) {
  const state = {
    messageID: undefined as SessionMessage.ID | undefined,
    ordinal: 0,
    message: "",
    blocks: new Map<string, { ordinal: number; type: "text" | "reasoning"; text: string }>(),
    tools: new Map<string, string>(),
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    diagnostics: new Map<string, number>(),
  }
  const begin = Effect.fn("ExternalAgentStream.begin")(function* () {
    if (state.messageID !== undefined) return
    state.messageID = SessionMessage.ID.create()
    state.ordinal = 0
    state.message = ""
    state.tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    state.cost = 0
    yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: state.messageID, agent, model })
  })
  const finish = Effect.fn("ExternalAgentStream.finish")(function* (error?: unknown) {
    if (state.messageID === undefined) return
    const base = { sessionID, assistantMessageID: state.messageID }
    for (const block of state.blocks.values()) {
      yield* bus.publish(block.type === "text" ? SessionEvent.Text.Ended : SessionEvent.Reasoning.Ended, {
        ...base,
        ordinal: block.ordinal,
        text: block.text,
      })
    }
    for (const id of state.tools.keys())
      yield* bus.publish(SessionEvent.Tool.Failed, {
        ...base,
        id,
        executed: true,
        error: toSessionError(error ?? new Error("External tool ended without a result")),
      })
    state.blocks.clear()
    state.tools.clear()
    if (error !== undefined)
      yield* bus.publish(SessionEvent.Step.Failed, {
        ...base,
        error: toSessionError(error),
        tokens: state.tokens,
        cost: Money.USD.make(state.cost),
      })
    if (error === undefined)
      yield* bus.publish(SessionEvent.Step.Ended, {
        ...base,
        finish: "stop",
        tokens: state.tokens,
        cost: Money.USD.make(state.cost),
      })
    state.messageID = undefined
  })
  const emit = Effect.fn("ExternalAgentStream.emit")(function* (event: ExternalAgentDriver.Event) {
    if (event.type === "status") return yield* progress(event)
    if (event.type === "diagnostic") {
      // Retain event names and counts only, never arbitrary vendor payloads or credentials.
      const name = event.name.slice(0, 100)
      if (state.diagnostics.size < 32 || state.diagnostics.has(name))
        state.diagnostics.set(name, Math.min(10_000, (state.diagnostics.get(name) ?? 0) + 1))
      return
    }
    if (event.type === "step-end") return yield* finish()
    if (event.type === "step-start") {
      yield* finish()
      return yield* begin()
    }
    if ((event.type === "tool-end" || event.type === "tool-progress") && !state.tools.has(event.id)) return
    yield* begin()
    const base = { sessionID, assistantMessageID: state.messageID! }
    if (event.type === "usage") {
      state.tokens.input += event.input
      state.tokens.output += event.output
      state.tokens.reasoning += event.reasoning ?? 0
      state.tokens.cache.read += event.cacheRead
      state.tokens.cache.write += event.cacheWrite ?? 0
      state.cost += event.cost ?? 0
      return
    }
    if (event.type === "text" || event.type === "reasoning") {
      const key = event.type + ":" + event.id
      const previous = state.blocks.get(key)
      const block = previous ?? { type: event.type, ordinal: state.ordinal++, text: "" }
      if (previous === undefined) {
        state.blocks.set(key, block)
        yield* bus.publish(event.type === "text" ? SessionEvent.Text.Started : SessionEvent.Reasoning.Started, {
          ...base,
          ordinal: block.ordinal,
        })
      }
      block.text += event.delta
      if (event.type === "text") state.message += event.delta
      yield* bus.publish(event.type === "text" ? SessionEvent.Text.Delta : SessionEvent.Reasoning.Delta, {
        ...base,
        ordinal: block.ordinal,
        delta: event.delta,
      })
      return
    }
    if (event.type === "tool-start") {
      if (state.tools.has(event.id)) return
      state.tools.set(event.id, event.name)
      // A structured submission's output is deliberately absent from the canonical transcript.
      const input = ["submit_result", "mcp__opencode__submit_result"].includes(event.name)
        ? { message: event.input.message }
        : event.input
      yield* bus.publish(SessionEvent.Tool.Input.Started, { ...base, id: event.id, name: event.name })
      yield* bus.publish(SessionEvent.Tool.Input.Ended, { ...base, id: event.id, text: JSON.stringify(input) })
      yield* bus.publish(SessionEvent.Tool.Called, { ...base, id: event.id, input, executed: true })
      return
    }
    if (event.type === "tool-progress")
      return yield* bus.publish(SessionEvent.Tool.Progress, { ...base, id: event.id, metadata: event.metadata })
    if (event.type === "tool-end") {
      if (!state.tools.has(event.id)) return
      state.tools.delete(event.id)
      if (event.error)
        return yield* bus.publish(SessionEvent.Tool.Failed, {
          ...base,
          id: event.id,
          executed: true,
          error: { type: "tool.execution", message: event.output },
        })
      yield* bus.publish(SessionEvent.Tool.Success, {
        ...base,
        id: event.id,
        executed: true,
        content: [{ type: "text", text: event.output || "Completed." }],
      })
    }
  })
  return {
    emit,
    finish,
    message: () => state.message,
    diagnostics: () => Object.fromEntries(state.diagnostics),
    source: (id?: string) =>
      id === undefined || state.messageID === undefined
        ? undefined
        : { type: "tool" as const, messageID: state.messageID, id },
  }
}
