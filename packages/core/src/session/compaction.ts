export * as SessionCompaction from "./compaction.js"

import { LLMClient, LLMEvent, Message } from "@ocpp/ai"
import { Agent } from "@ocpp/schema/agent"
import { Money } from "@ocpp/schema/money"
import { SessionError } from "@ocpp/schema/session-error"
import { TokenUsage } from "@ocpp/schema/token-usage"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { Bus } from "../bus.js"
import { makeLocationNode } from "@ocpp/util/effect/app-node"
import { llmClient } from "../effect/app-node-platform.js"
import { SessionEvent } from "./event.js"
import type { SessionContext } from "./context.js"
import type { SessionMessage } from "./message.js"
import type { SessionModelRequest } from "./model-request.js"
import type { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { toSessionError } from "./to-session-error.js"
import { Token } from "../util/token.js"
import { SessionUsage } from "./usage.js"
import { State } from "../state.js"
import { SpecterRejection } from "../specter/rejection.js"

const encodeUsage = Schema.encodeSync(SessionEvent.UsageRecorded.data)

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 15_000
const OUTPUT_TOKEN_MAX = 32_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the user is trying to accomplish]

## Important Details
- [constraints/preferences, decisions and why, important facts/assumptions, exact context needed to continue, or "(none)"]

## Work State
### Completed
- [finished work, verified facts, or changes made; otherwise "(none)"]

### Active
- [current work, partial changes, or investigation state; otherwise "(none)"]

### Blocked
- [blockers, failing commands, or unknowns; otherwise "(none)"]

## Next Move
1. [immediate concrete action, or "(none)"]
2. [next action if known, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

export type Settings = {
  auto: boolean
  buffer: number
  tokens: number
}

export type Draft = {
  configure: (settings: Partial<Settings>) => void
}

/**
 * Records a compaction's facts: its start, what it spent and how it settled. Each answers false once the runtime
 * refused it (the Session is gone), and the compaction stops. The runtime's attempt records a compaction it runs;
 * an external agent's harness records through the Bus (`record`).
 */
export interface Recorder {
  readonly started: (start: {
    readonly reason: SessionMessage.Compaction["reason"]
    readonly recent: string
    readonly inputID?: SessionMessage.ID
  }) => Effect.Effect<boolean>
  /** What a compaction spent when it records no outcome of its own. */
  readonly usage: (usage: SessionUsage.Recorded) => Effect.Effect<boolean>
  /** How it ended, with what it spent, in one commit. */
  readonly settled: (settled: Settled, usage?: SessionUsage.Recorded) => Effect.Effect<boolean>
}

export type Settled =
  | {
      readonly reason: SessionMessage.Compaction["reason"]
      readonly outcome: "completed"
      readonly text: string
      readonly recent: string
    }
  | {
      readonly reason: SessionMessage.Compaction["reason"]
      readonly outcome: "failed"
      readonly error: SessionError.Error
      readonly inputID?: SessionMessage.ID
    }

const encodeSettled = Schema.encodeSync(SessionEvent.Compaction.Settled.data)
const encodeStarted = Schema.encodeSync(SessionEvent.Compaction.Started.data)
const encodeUsageFields = Schema.encodeSync(Schema.Struct({ cost: Money.USD, tokens: TokenUsage.Info }))

/** A Session's compaction facts as the Bus dispatches them: for a compaction no runtime attempt runs. */
export const record = (bus: Bus.Interface, sessionID: SessionSchema.ID): Recorder => {
  const dispatch = (command: Bus.RuntimeCommand) =>
    bus.command(command).pipe(
      Effect.as(true),
      Effect.catchIf(SpecterRejection.isMissingSession, () => Effect.succeed(false)),
      Effect.orDie,
    )
  return {
    started: (start) => dispatch({ type: "startCompaction", payload: encodeStarted({ sessionID, ...start }) }),
    usage: (usage) =>
      dispatch({ type: "recordUsage", payload: encodeUsage({ sessionID, source: "compaction", ...usage }) }),
    settled: (settled, usage) =>
      dispatch({
        type: "settleCompaction",
        payload: {
          ...encodeSettled({ sessionID, ...settled }),
          ...(usage === undefined ? {} : { usage: encodeUsageFields(usage) }),
        },
      }),
  }
}

export type AutoInput = {
  readonly session: SessionSchema.Info
  readonly messages: readonly SessionMessage.Info[]
  readonly resolved: SessionRunnerModel.Resolved
  readonly prepare: SessionModelRequest.Interface["prepare"]
  readonly record: Recorder
}

type RequiredInput = Pick<AutoInput, "messages" | "resolved">

export type ManualInput = {
  readonly session: SessionSchema.Info
  readonly messages: readonly SessionMessage.Info[]
  readonly inputID: SessionMessage.ID
  readonly started?: boolean
  /** Invoked after content planning, not when the caller captures the operation. */
  readonly resolveModel: SessionContext.Interface["resolveModel"]
  readonly prepare: SessionModelRequest.Interface["prepare"]
  readonly record: Recorder
}

export type GeneratedInput = {
  readonly session: SessionSchema.Info
  readonly messages: readonly SessionMessage.Info[]
  readonly reason: SessionMessage.Compaction["reason"]
  readonly inputID?: SessionMessage.ID
  readonly started?: boolean
  readonly record: Recorder
  readonly generate: (
    prompt: string,
    delta: (text: string) => Effect.Effect<void>,
  ) => Effect.Effect<{ readonly text: string; readonly usage?: SessionUsage.Recorded }, unknown>
}

type Plan = {
  readonly session: SessionSchema.Info
  readonly reason: SessionMessage.Compaction["reason"]
  readonly prompt: string
  readonly recent: string
  readonly inputID?: SessionMessage.ID
  readonly started?: boolean
  readonly record: Recorder
} & (Pick<AutoInput, "resolved" | "prepare"> | Pick<GeneratedInput, "generate">)

export type Outcome =
  | Pick<SessionMessage.CompactionCompleted, "status">
  | Pick<SessionMessage.CompactionFailed, "status" | "error">
  // A record was refused: the Session is gone, and nothing more is recorded.
  | { readonly status: "stopped" }

export interface Interface extends State.Transformable<Draft> {
  readonly enabled: () => boolean
  readonly required: (input: RequiredInput) => boolean
  readonly compact: (input: AutoInput) => Effect.Effect<Outcome>
  readonly compactManual: (input: ManualInput) => Effect.Effect<Outcome>
  readonly compactWith: (input: GeneratedInput) => Effect.Effect<Outcome>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/SessionCompaction") {}

export const truncateToolOutput = (value: string) => {
  if (value.length <= TOOL_OUTPUT_MAX_CHARS) return value
  let end = 0
  for (let count = 0; count < TOOL_OUTPUT_MAX_CHARS && end < value.length; count++) {
    const code = value.charCodeAt(end)
    end +=
      code >= 0xd800 && code <= 0xdbff && value.charCodeAt(end + 1) >= 0xdc00 && value.charCodeAt(end + 1) <= 0xdfff
        ? 2
        : 1
  }
  if (end === value.length) return value
  return `${value.slice(0, end)}\n[truncated]`
}

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

const serialize = (message: SessionMessage.Info) => {
  if (message.type === "user") {
    const files =
      message.files?.map(
        (file) =>
          `[Attached ${file.mime}: ${file.name ?? (file.source.type === "uri" ? file.source.uri : "inline attachment")}]`,
      ) ?? []
    const skills =
      message.skills?.flatMap((skill) =>
        skill.text === undefined ? [] : [`[Skill activated: ${skill.name}]\n${skill.text}`],
      ) ?? []
    return [...skills, `[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "location-switched")
    return `[User]: The working directory has been changed to ${message.location.directory}.`
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncateToolOutput(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic")
    return `[Synthetic context]: ${
      message.metadata?.source === "codemode" ? truncateToolOutput(message.text) : message.text
    }`
  if (message.type === "skill") return `[Skill activated: ${message.name}]\n${message.text}`
  if (message.type === "shell")
    return message.metadata?.background === true
      ? ""
      : `[Shell]: ${message.command}\n${truncateToolOutput(message.output?.output ?? "")}`
  return ""
}

const select = (
  messages: readonly SessionMessage.Info[],
  tokens: number,
): { readonly head: string; readonly recent: string } | undefined => {
  const conversation = messages
    .filter((message) => message.type !== "compaction" && message.type !== "system")
    .flatMap((message) => {
      const text = serialize(message)
      return text ? [{ message, text }] : []
    })
  if (conversation.length === 0) return undefined
  let total = 0
  let split = conversation.length
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index].text)
    if (split < conversation.length && next > tokens) break
    total = next
    split = index
  }
  while (split > 0 && conversation[split].message.type !== "user") split--
  if (split === 0) {
    const latestUser = conversation.findLastIndex((item) => item.message.type === "user")
    if (latestUser > 0) split = latestUser
  }
  return {
    head: conversation
      .slice(0, split)
      .map((item) => item.text)
      .join("\n\n"),
    recent: conversation
      .slice(split)
      .map((item) => item.text)
      .join("\n\n"),
  }
}

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) =>
  [
    input.previousSummary
      ? `Update the anchored summary below using the conversation history below.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${input.previousSummary}\n</previous-summary>`
      : "Create a new anchored summary from the conversation history.",
    SUMMARY_TEMPLATE,
    "The following is the conversation history:",
    ...input.context,
  ].join("\n\n")

const planContent = (messages: readonly SessionMessage.Info[], tokens: number) => {
  const selected = select(messages, tokens)
  if (!selected) return
  const previousSummary = messages.findLast(
    (message): message is SessionMessage.CompactionCompleted =>
      message.type === "compaction" && message.status === "completed",
  )
  const previousRecent = previousSummary?.recent ?? ""
  const summarizeRecent = !previousRecent && !selected.head
  return {
    prompt: buildPrompt({
      previousSummary: previousSummary?.summary,
      context: summarizeRecent ? [selected.recent] : [previousRecent, selected.head].filter(Boolean),
    }),
    recent: summarizeRecent ? "" : selected.recent,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const llm = yield* LLMClient.Service

    const state = State.create<Settings, Draft>({
      name: "session-compaction",
      initial: () => ({ auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS }),
      draft: (draft) => ({
        configure: (settings) => {
          if (settings.auto !== undefined) draft.auto = settings.auto
          if (settings.buffer !== undefined) draft.buffer = settings.buffer
          if (settings.tokens !== undefined) draft.tokens = settings.tokens
        },
      }),
    })
    const stopped = { status: "stopped" } as const
    const failed = Effect.fnUntraced(function* (
      record: Recorder,
      input: {
        readonly reason: SessionMessage.Compaction["reason"]
        readonly error: SessionError.Error
        readonly inputID?: SessionMessage.ID
      },
      usage?: SessionUsage.Recorded,
    ) {
      if (
        !(yield* record.settled(
          {
            reason: input.reason,
            outcome: "failed",
            error: input.error,
            ...(input.inputID === undefined ? {} : { inputID: input.inputID }),
          },
          usage,
        ))
      )
        return stopped
      return { status: "failed" as const, error: input.error }
    })
    const execute = Effect.fn("SessionCompaction.execute")(function* (plan: Plan) {
      if (
        !plan.started &&
        !(yield* plan.record.started({
          reason: plan.reason,
          recent: plan.recent,
          ...(plan.inputID === undefined ? {} : { inputID: plan.inputID }),
        }))
      )
        return stopped

      const chunks: string[] = []
      let failure: SessionError.Error | undefined
      let usage: SessionUsage.Recorded | undefined
      yield* Effect.gen(function* () {
        if ("generate" in plan) {
          const result = yield* plan
            .generate(plan.prompt, (text) =>
              bus.publish(SessionEvent.Compaction.Delta, { sessionID: plan.session.id, text }).pipe(Effect.asVoid),
            )
            .pipe(Effect.result)
          if (result._tag === "Failure") failure = toSessionError(result.failure)
          if (result._tag === "Success") {
            chunks.push(result.success.text)
            usage = result.success.usage
          }
          return
        }
        const prepared = yield* plan.prepare({
          scope: { session: plan.session, agentID: Agent.ID.make("compaction"), model: plan.resolved },
          transcript: { system: [], messages: [Message.user(plan.prompt)] },
          contextHooks: false,
        })
        yield* llm.stream(prepared.request, prepared.options).pipe(
          Stream.runForEach((event) => {
            if (LLMEvent.is.providerError(event))
              failure = {
                type: event.classification === "context-overflow" ? "provider.invalid-request" : "provider.error",
                message: event.message,
              }
            if (LLMEvent.is.textDelta(event)) {
              chunks.push(event.text)
              return bus.publish(SessionEvent.Compaction.Delta, {
                sessionID: plan.session.id,
                text: event.text,
              })
            }
            if (LLMEvent.is.stepFinish(event)) {
              const step = SessionUsage.record(event.usage, plan.resolved.cost)
              usage = usage ? SessionUsage.add(usage, step) : step
            }
            return Effect.void
          }),
          Effect.catchTag("AI.Error", (error) =>
            Effect.sync(() => {
              failure = toSessionError(error)
            }),
          ),
        )
      }).pipe(
        // An interrupted automatic compaction fails with what it spent; a manual one leaves its failure to its
        // host, so it records only what it spent.
        Effect.onInterrupt(() =>
          plan.reason === "auto"
            ? failed(
                plan.record,
                {
                  reason: plan.reason,
                  error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
                  inputID: plan.inputID,
                },
                usage,
              )
            : usage
              ? plan.record.usage(usage)
              : Effect.void,
        ),
      )
      const summary = chunks.join("")
      if (failure || !summary.trim()) {
        const error = failure ?? { type: "compaction.failed" as const, message: "Compaction produced no summary" }
        return yield* failed(plan.record, { reason: plan.reason, error, inputID: plan.inputID }, usage)
      }
      if (
        !(yield* plan.record.settled(
          { reason: plan.reason, outcome: "completed", text: summary, recent: plan.recent },
          usage,
        ))
      )
        return stopped
      return { status: "completed" as const }
    })
    const compact = Effect.fn("SessionCompaction.compact")(function* (input: AutoInput) {
      const content = planContent(input.messages, state.get().tokens)
      if (content)
        return yield* execute({
          session: input.session,
          resolved: input.resolved,
          prepare: input.prepare,
          reason: "auto",
          record: input.record,
          ...content,
        })
      return yield* failed(input.record, {
        reason: "auto",
        error: { type: "compaction.unavailable", message: "Nothing to compact yet" },
      })
    })
    const required = (input: RequiredInput) => {
      const config = state.get()
      if (!config.auto) return false
      const limit = input.resolved.limit
      const context = limit.context
      if (context <= 0) return false
      const last = input.messages.findLast(
        (message): message is SessionMessage.Assistant & { tokens: NonNullable<SessionMessage.Assistant["tokens"]> } =>
          message.type === "assistant" && message.tokens !== undefined,
      )
      if (!last) return false
      const output = Math.min(limit.output, OUTPUT_TOKEN_MAX)
      const promptCeiling = Math.min(
        limit.input === undefined ? Number.POSITIVE_INFINITY : limit.input - config.buffer,
        context - Math.max(output, config.buffer),
      )
      const used =
        last.tokens.input +
        last.tokens.output +
        last.tokens.reasoning +
        last.tokens.cache.read +
        last.tokens.cache.write
      if (used <= 0) return false
      return used >= promptCeiling
    }
    const compactManual = Effect.fn("SessionCompaction.compactManual")(function* (input: ManualInput) {
      const content = planContent(input.messages, state.get().tokens)
      if (!content)
        return yield* failed(input.record, {
          reason: "manual",
          error: { type: "compaction.unavailable", message: "Nothing to compact yet" },
          inputID: input.inputID,
        })
      return yield* input.resolveModel(input.session).pipe(
        Effect.matchEffect({
          onFailure: (cause) =>
            failed(input.record, {
              reason: "manual",
              error: toSessionError(cause),
              inputID: input.inputID,
            }),
          onSuccess: (resolved) =>
            execute({
              session: input.session,
              resolved,
              prepare: input.prepare,
              reason: "manual",
              inputID: input.inputID,
              started: input.started,
              record: input.record,
              ...content,
            }),
        }),
      )
    })
    const compactWith = Effect.fn("SessionCompaction.compactWith")(function* (input: GeneratedInput) {
      const content = planContent(input.messages, state.get().tokens)
      if (!content)
        return yield* failed(input.record, {
          reason: input.reason,
          error: { type: "compaction.unavailable", message: "Nothing to compact yet" },
          inputID: input.inputID,
        })
      return yield* execute({ ...input, ...content })
    })
    return Service.of({
      transform: state.transform,
      reload: state.reload,
      enabled: () => state.get().auto,
      required,
      compact,
      compactManual,
      compactWith,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, llmClient],
})
