export * as ExternalAgentStream from "./stream.js"

import { Money } from "@ocpp/schema/money"
import type { Agent } from "@ocpp/schema/agent"
import type { Model } from "@ocpp/schema/model"
import type { Session } from "@ocpp/schema/session"
import type { SessionError } from "@ocpp/schema/session-error"
import type { Tool } from "@ocpp/schema/tool"
import { Deferred, Effect, Semaphore } from "effect"
import { Bus } from "../bus.js"
import { SessionEvent } from "../session/event.js"
import { SessionMessage } from "../session/message.js"
import { toSessionError } from "../session/to-session-error.js"
import type { ExternalAgentDriver } from "./driver.js"

/** Vendor names for OC++'s own `execute`: an MCP tool for Claude and Codex, a custom tool for Pi. */
const EXECUTE = new Set(["execute", "mcp__ocpp__execute"])

/** A vendor call to OC++'s `execute`, recorded under the tool part the vendor announced for it. */
export interface Call {
  readonly messageID: SessionMessage.ID
  readonly id: string
}

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
    tools: new Map<
      string,
      { readonly messageID: SessionMessage.ID; readonly execute: boolean; readonly input: string; claimed: boolean }
    >(),
    // Settled calls ignore late vendor announcements and results for the same ID.
    settled: new Set<string>(),
    waiting: [] as Array<{ readonly input: string; readonly call: Deferred.Deferred<Call> }>,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    diagnostics: new Map<string, number>(),
  }
  // Vendor events and OC++ `execute` calls arrive on different fibers; each publication sequence is atomic.
  const lock = Semaphore.makeUnsafe(1)
  const begin = Effect.fn("ExternalAgentStream.begin")(function* () {
    if (state.messageID !== undefined) return state.messageID
    const messageID = SessionMessage.ID.create()
    state.messageID = messageID
    state.ordinal = 0
    state.message = ""
    state.tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    state.cost = 0
    yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID: messageID, agent, model })
    return messageID
  })
  const finish = Effect.fn("ExternalAgentStream.finish")(function* (error?: unknown) {
    // A turn that fails before the vendor produced anything still ends in a failed step, so its error shows in the
    // timeline as a provider error does. A turn interrupted before any output leaves no step behind.
    if (state.messageID === undefined && (error === undefined || toSessionError(error).type === "aborted")) return
    const base = { sessionID, assistantMessageID: yield* begin() }
    for (const block of state.blocks.values()) {
      yield* bus.publish(SessionEvent.Block.Recorded, {
        ...base,
        kind: block.type,
        ordinal: block.ordinal,
        text: block.text,
      })
    }
    for (const [id, tool] of state.tools) {
      state.settled.add(id)
      yield* bus.publish(SessionEvent.Tool.Settled, {
        sessionID,
        assistantMessageID: tool.messageID,
        id,
        outcome: "failed",
        executed: !tool.claimed,
        error: toSessionError(error ?? new Error("External tool ended without a result")),
      })
    }
    state.blocks.clear()
    state.tools.clear()
    if (error !== undefined)
      yield* bus.publish(SessionEvent.Step.Settled, {
        ...base,
        outcome: "failed",
        error: toSessionError(error),
        tokens: state.tokens,
        cost: Money.USD.make(state.cost),
      })
    if (error === undefined)
      yield* bus.publish(SessionEvent.Step.Settled, {
        ...base,
        outcome: "succeeded",
        finish: "stop",
        tokens: state.tokens,
        cost: Money.USD.make(state.cost),
      })
    state.messageID = undefined
  })
  const announce = Effect.fn("ExternalAgentStream.announce")(function* (
    id: string,
    name: string,
    input: Record<string, unknown>,
  ) {
    const messageID = yield* begin()
    const execute = EXECUTE.has(name)
    const text = JSON.stringify(input)
    state.tools.set(id, { messageID, execute, input: text, claimed: false })
    // A structured submission's output is deliberately absent from the canonical transcript.
    const recorded = ["submit_result", "mcp__ocpp__submit_result"].includes(name) ? { message: input.message } : input
    // OC++ runs `execute` itself, so it is recorded like a runner-owned call rather than a vendor-hosted one.
    yield* bus.publish(SessionEvent.Tool.Requested, {
      sessionID,
      assistantMessageID: messageID,
      id,
      name: execute ? "execute" : name,
      input: recorded,
      executed: !execute,
    })
    if (!execute) return
    const waiter = state.waiting.findIndex((item) => item.input === text)
    if (waiter === -1) return
    const tool = state.tools.get(id)!
    tool.claimed = true
    yield* Deferred.succeed(state.waiting[waiter].call, { messageID, id })
    state.waiting.splice(waiter, 1)
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
      yield* begin()
      return
    }
    if (event.type === "tool-start") {
      if (state.tools.has(event.id) || state.settled.has(event.id)) return
      return yield* announce(event.id, event.name, event.input)
    }
    const tool = event.type === "tool-end" || event.type === "tool-progress" ? state.tools.get(event.id) : undefined
    // OC++ settles the `execute` calls it claimed with their own results.
    if ((event.type === "tool-end" || event.type === "tool-progress") && (tool === undefined || tool.claimed)) return
    const messageID = yield* begin()
    const base = { sessionID, assistantMessageID: messageID }
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
        yield* bus.publish(SessionEvent.Block.Started, { ...base, kind: block.type, ordinal: block.ordinal })
      }
      block.text += event.delta
      if (event.type === "text") state.message += event.delta
      yield* bus.publish(SessionEvent.Block.Delta, {
        ...base,
        kind: block.type,
        ordinal: block.ordinal,
        delta: event.delta,
      })
      return
    }
    if (tool === undefined) return
    const call = { sessionID, assistantMessageID: tool.messageID, id: event.id }
    if (event.type === "tool-progress")
      return yield* bus.publish(SessionEvent.Tool.Progress, { ...call, metadata: event.metadata })
    if (event.type !== "tool-end") return
    state.tools.delete(event.id)
    state.settled.add(event.id)
    if (event.error)
      return yield* bus.publish(SessionEvent.Tool.Settled, {
        ...call,
        outcome: "failed",
        executed: true,
        error: { type: "tool.execution", message: event.output },
      })
    yield* bus.publish(SessionEvent.Tool.Settled, {
      ...call,
      outcome: "succeeded",
      executed: true,
      content: [{ type: "text", text: event.output || "Completed." }],
    })
  })
  /**
   * Binds a vendor's call to OC++'s `execute` to its announced tool part. Claude names the call's ID; Codex does
   * not, so its call is matched by input with the announcement, which may still be in flight on the event stream.
   */
  const claim = Effect.fn("ExternalAgentStream.claim")(function* (input: {
    readonly id?: string
    readonly input: Record<string, unknown>
  }) {
    const text = JSON.stringify(input.input)
    const call = Deferred.makeUnsafe<Call>()
    yield* lock.withPermit(
      Effect.gen(function* () {
        const id =
          input.id ??
          Array.from(state.tools).find(([, tool]) => tool.execute && !tool.claimed && tool.input === text)?.[0]
        if (id !== undefined && !state.tools.has(id) && !state.settled.has(id))
          yield* announce(id, "execute", input.input)
        const tool = id === undefined ? undefined : state.tools.get(id)
        if (id === undefined || tool === undefined) {
          state.waiting.push({ input: text, call })
          return
        }
        tool.claimed = true
        yield* Deferred.succeed(call, { messageID: tool.messageID, id })
      }),
    )
    return yield* Deferred.await(call)
  })
  /** Records the outcome of a claimed `execute` call exactly as the runner records its own tool results. */
  const settle = Effect.fn("ExternalAgentStream.settle")(function* (
    call: Call,
    outcome:
      | { readonly _tag: "Success"; readonly result: Tool.Result }
      | { readonly _tag: "Failure"; readonly error: SessionError.Error; readonly metadata?: Tool.Metadata },
  ) {
    if (!state.tools.has(call.id)) return
    state.tools.delete(call.id)
    state.settled.add(call.id)
    const base = { sessionID, assistantMessageID: call.messageID, id: call.id, executed: false }
    if (outcome._tag === "Failure")
      return yield* bus.publish(SessionEvent.Tool.Settled, {
        ...base,
        outcome: "failed",
        error: outcome.error,
        ...(outcome.metadata === undefined ? {} : { metadata: outcome.metadata }),
      })
    const content =
      typeof outcome.result.content === "string"
        ? [{ type: "text" as const, text: outcome.result.content }]
        : [...(outcome.result.content ?? [])]
    yield* bus.publish(SessionEvent.Tool.Settled, {
      ...base,
      outcome: "succeeded",
      content: content.length === 0 ? [{ type: "text", text: "Completed." }] : [content[0], ...content.slice(1)],
      ...(outcome.result.metadata === undefined ? {} : { metadata: outcome.result.metadata }),
    })
  })
  return {
    emit: (event: ExternalAgentDriver.Event) => lock.withPermit(emit(event)),
    finish: (error?: unknown) => lock.withPermit(finish(error)),
    claim,
    settle: (...args: Parameters<typeof settle>) => lock.withPermit(settle(...args)),
    progress: (call: Call, metadata: Tool.Metadata) =>
      bus.publish(SessionEvent.Tool.Progress, { sessionID, assistantMessageID: call.messageID, id: call.id, metadata }),
    message: () => state.message,
    diagnostics: () => Object.fromEntries(state.diagnostics),
    source: (id?: string) => {
      const tool = id === undefined ? undefined : state.tools.get(id)
      return tool === undefined ? undefined : { type: "tool" as const, messageID: tool.messageID, id: id! }
    },
  }
}
