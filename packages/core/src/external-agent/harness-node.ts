export * as ExternalAgentHarnessNode from "./harness-node.js"

import { Message, isContextOverflow, type ToolResultValue } from "@ocpp/ai"
import { ProviderShared } from "@ocpp/ai/protocols/shared"
import { ExternalSession } from "@ocpp/schema/external-session"
import type { Model } from "@ocpp/schema/model"
import { Money } from "@ocpp/schema/money"
import { SessionDriver } from "@ocpp/schema/session-driver"
import type { SessionError } from "@ocpp/schema/session-error"
import { makeLocationNode } from "@ocpp/util/effect/app-node"
import { Hash } from "@ocpp/util/hash"
import { Cause, Deferred, Effect, Exit, FiberMap, Layer, Option, Schema } from "effect"
import { Bus } from "../bus.js"
import { CodeModeInstructions } from "../codemode/instructions.js"
import { CodeModeStore } from "../codemode/store.js"
import { Database } from "../database/database.js"
import { Instructions } from "../instructions/index.js"
import { SessionContext } from "../session/context.js"
import { SessionCompaction } from "../session/compaction.js"
import { StepFailedError } from "../session/error.js"
import { ExternalAgentHarness } from "./harness.js"
import { SessionEvent } from "../session/event.js"
import { SessionInbox } from "../session/inbox.js"
import { SessionMessage } from "../session/message.js"
import { SessionModelRequest } from "../session/model-request.js"
import { DrainResult } from "../session/runner/index.js"
import { settleStaleToolCalls } from "../session/runner/stale.js"
import { toLLMMessages } from "../session/runner/to-llm-message.js"
import { SessionSchema } from "../session/schema.js"
import { SessionStore } from "../session/store.js"
import { SessionTitle } from "../session/title.js"
import { toSessionError } from "../session/to-session-error.js"
import { Tool } from "../tool.js"
import { QuestionTool } from "../tool/plugin/question.js"
import { definition, execute } from "../tool/runtime.js"
import { ExternalAgentDriver } from "./driver.js"
import { ExternalAgentDrivers } from "./drivers.js"
import { ExternalAgentGateway } from "./gateway.js"
import { ExternalAgentSession } from "./session.js"
import { ExternalAgentStream } from "./stream.js"

const layer = Layer.effect(
  ExternalAgentHarness.Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const db = (yield* Database.Service).db
    const store = yield* SessionStore.Service
    const notebook = yield* CodeModeStore.Service
    const external = yield* ExternalAgentSession.Service
    const context = yield* SessionContext.Service
    const compaction = yield* SessionCompaction.Service
    const drivers = yield* ExternalAgentDrivers.Service
    const title = yield* SessionTitle.Service
    // Title generation starts once input is visible and must not delay the vendor.
    const titles = yield* FiberMap.make<SessionSchema.ID, void, never>()

    const drain = Effect.fn("ExternalAgentHarness.drain")(function* (
      input: Parameters<ExternalAgentHarness.Interface["drain"]>[0],
    ) {
      const sessionID = input.sessionID
      // The runtime's inbox: its delivery law orders what goes in, and it records each delivery.
      const peek = (at: "idle" | "step" | "entry") => input.inbox.next(at).pipe(Effect.orDie)
      // A continued turn takes steers and the control items at the queue's head; any other takes queued input too.
      const restAt = (scope: SessionInbox.Promotable) => (scope === "steer" ? ("entry" as const) : ("idle" as const))
      // Delivers input up to the next control item and returns what it delivered, in delivery order.
      const promote = Effect.fnUntraced(function* (from: "idle" | "step" | "entry") {
        const delivered: SessionMessage.ID[] = []
        let at = from
        while (true) {
          const item = yield* peek(at)
          if (item === null || item.type === "compaction" || item.type === "move") return delivered
          if (!(yield* input.inbox.deliver(item.inboxID).pipe(Effect.orDie))) return delivered
          delivered.push(SessionMessage.ID.make(item.inboxID))
          at = "step"
        }
      })
      const pending = yield* peek("idle")
      const control = pending?.type === "compaction" || pending?.type === "move"
      if (
        !input.force &&
        (pending === null || (input.promotable === "steer" && pending.delivery === "queue" && !control))
      )
        return DrainResult.Complete()
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
      const provider = SessionDriver.of(session.model)
      if (provider === "ocpp" || session.model === undefined)
        return yield* Effect.die(new Error(`Session is not vendor-driven: ${sessionID}`))
      const model = session.model
      const directory = session.location.directory
      const activation = yield* external.activation(sessionID)
      // Only a subagent call may run a vendor natively; everything else, including every top-level Session, is harnessed.
      const harness = activation?.harness ?? "ocpp"
      yield* settleStaleToolCalls(store, bus, sessionID)
      const stale = (yield* store.context(sessionID)).filter(
        (message): message is SessionMessage.CompactionRunning =>
          message.type === "compaction" && message.status === "running",
      )
      yield* Effect.forEach(stale, (message) =>
        bus.publish(SessionEvent.Compaction.Failed, {
          sessionID,
          reason: message.reason,
          inputID: message.id,
          error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
        }),
      )
      const selection = yield* context.select(sessionID)
      const agent = selection.agent.id
      const system = Effect.fnUntraced(function* (checkpoint: ReadonlyArray<string>) {
        const current = yield* context.select(sessionID)
        const instructions = yield* Instructions.renderCurrent(current.instructions)
        return SessionModelRequest.systemPrompt({
          agent: selection.agent.info,
          tools: selection.tools,
          initial: [instructions, yield* CodeModeInstructions.notebook(notebook, sessionID, checkpoint)]
            .filter((part) => part.length > 0)
            .join("\n\n"),
        }).join("\n\n")
      })
      const stream = ExternalAgentStream.make(bus, sessionID, agent, model)
      const sdk = yield* drivers.driver(provider).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const failure = new StepFailedError({ error: { type: "driver.unavailable", message: error.message } })
            // As a provider error answers a prompt for the OC++ runner, the failure answers the prompt in the timeline
            // instead of leaving it pending. The vendor never answered it, so it still receives it once it is ready.
            if (!control && (yield* promote(restAt(input.promotable ?? "input"))).length > 0)
              yield* stream.finish(failure)
            return yield* failure
          }),
        ),
      )

      // Rung by every admission to this Session's inbox; a waiter captures the bell before checking its condition.
      const bell = { current: Deferred.makeUnsafe<void>() }
      const ring = Effect.suspend(() => {
        const rung = bell.current
        bell.current = Deferred.makeUnsafe<void>()
        return Deferred.succeed(rung, undefined)
      })
      // Executions this drain started are owed a completion notification before the vendor may go idle.
      const executions = { launched: new Set<string>(), notified: new Set<string>() }
      yield* Effect.acquireRelease(
        bus.listen((event) => {
          if (!isEnqueued(event) || event.data.sessionID !== sessionID) return Effect.void
          const item = event.data.item
          const executionID = item.type === "synthetic" ? item.payload.metadata?.executionID : undefined
          if (typeof executionID === "string") executions.notified.add(executionID)
          return ring.pipe(Effect.asVoid)
        }),
        (unsubscribe) => unsubscribe,
      )
      const state = {
        idle: true,
        moved: false,
        started: false,
        vendor: undefined as string | undefined,
        compacting: false,
        continuation: false,
        overflow: false,
      }
      const compact = Effect.fnUntraced(function* (reason: "manual" | "auto", inputID?: SessionMessage.ID) {
        const current = yield* store.get(sessionID)
        if (!current) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
        const outcome = yield* compaction.compactWith({
          session: current,
          messages: yield* store.context(sessionID),
          reason,
          inputID,
          started: reason === "manual",
          generate: (prompt, delta) =>
            Effect.gen(function* () {
              const chunks: string[] = []
              const usage = {
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                cost: Money.USD.zero,
              }
              // OC++ owns the plan and durable result. The vendor only answers a fresh, tool-free summary request.
              yield* ExternalAgentDriver.execute(sdk, {
                directory,
                model: model.id,
                effort: model.variant === "default" ? undefined : model.variant,
                history: [],
                message: [{ type: "text", text: prompt }],
                harness: {
                  type: "ocpp",
                  system: "Summarize the supplied conversation. Do not use tools. Follow the requested summary format.",
                },
                gateway: ExternalAgentGateway.make([]),
                emit: async (event) => {
                  if (event.type === "text") {
                    chunks.push(event.delta)
                    await Effect.runPromise(delta(event.delta))
                  }
                  if (event.type === "tool-start") throw new Error("The summary driver attempted tools")
                  if (event.type !== "usage") return
                  usage.tokens.input += event.input
                  usage.tokens.output += event.output
                  usage.tokens.reasoning += event.reasoning ?? 0
                  usage.tokens.cache.read += event.cacheRead
                  usage.tokens.cache.write += event.cacheWrite ?? 0
                  usage.cost = Money.USD.make(usage.cost + (event.cost ?? 0))
                },
                linked: async () => {},
                checkpointed: async () => {},
                next: async () => undefined,
                idle: () => {},
              })
              return { text: chunks.join(""), usage }
            }),
        })
        if (outcome.status === "failed") return yield* new StepFailedError({ error: outcome.error })
        state.vendor = undefined
      })

      const deliver = Effect.fnUntraced(function* (items: ReadonlyArray<SessionMessage.ID>) {
        const messages = yield* Effect.forEach(items, (item) => store.message(item))
        return ExternalAgentDriver.join(
          messages.flatMap((stored) => (stored === undefined ? [] : toLLMMessages([stored.message], model))).map(lower),
        )
      })
      // Steers join a running vendor turn; at idle, queued input and control items are handled as the runner does.
      const take = (scope: SessionInbox.Promotable): Effect.Effect<ExternalAgentDriver.Input | undefined> =>
        Effect.gen(function* () {
          while (true) {
            const rung = bell.current
            if (state.idle) {
              const head = yield* peek(restAt(scope))
              if (head?.type === "move") {
                state.moved = true
                return undefined
              }
              if (head?.type === "compaction") {
                state.compacting = true
                return undefined
              }
            }
            const items = yield* promote(state.idle ? restAt(scope) : "step")
            if (items.length > 0) {
              state.idle = false
              return yield* deliver(items)
            }
            if (state.idle && [...executions.launched].every((id) => executions.notified.has(id))) return undefined
            yield* Deferred.await(rung)
          }
        })

      const invokeExecute = Effect.fnUntraced(function* (value: Record<string, unknown>, id?: string) {
        const call = yield* stream.claim({ id, input: value })
        const exit = yield* selection.tools
          .execute({
            sessionID,
            agent,
            messageID: call.messageID,
            call: { type: "tool-call", id: call.id, name: "execute", input: value },
            progress: (update) => stream.progress(call, update),
          })
          .pipe(Effect.exit)
        if (Exit.isSuccess(exit)) {
          const executionID = exit.value.metadata?.executionID
          // Recorded before the settlement that lets the execution start, so its notification cannot be missed.
          if (typeof executionID === "string") executions.launched.add(executionID)
          yield* stream.settle(call, { _tag: "Success", result: exit.value })
          return text(exit.value.content)
        }
        if (Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.interrupt
        const failure = Cause.squash(exit.cause)
        const error: SessionError.Error =
          failure instanceof QuestionTool.CancelledError
            ? { type: "aborted", message: failure.message }
            : toSessionError(failure)
        yield* stream.settle(call, {
          _tag: "Failure",
          error,
          ...(failure instanceof Tool.Error && failure.metadata !== undefined ? { metadata: failure.metadata } : {}),
        })
        return yield* Effect.fail(error.message)
      })
      const execution = selection.tools.definitions.find((tool) => tool.name === "execute")
      const gateway = ExternalAgentGateway.make([
        ...(execution === undefined
          ? []
          : [
              {
                name: "execute",
                description: execution.description,
                inputSchema: execution.inputSchema as Record<string, Schema.Json>,
                invoke: invokeExecute,
              },
            ]),
        // The native harness also offers the call's own tools directly; they stay reachable from execute too.
        ...(harness === "native" ? (activation?.tools ?? []) : []).flatMap((tool) => {
          const described = definition(tool)
          if (described.inputSchema.type !== "object") return []
          return [
            {
              name: described.name,
              description: described.description,
              inputSchema: described.inputSchema as Record<string, Schema.Json>,
              invoke: (value: Record<string, unknown>, id?: string) =>
                execute(tool, value, {
                  sessionID,
                  agent,
                  messageID: stream.source(id)?.messageID ?? SessionMessage.ID.create(),
                  id: Tool.CallID.make(id ?? crypto.randomUUID()),
                  progress: () => Effect.void,
                }).pipe(
                  Effect.map((result) => text(result.content)),
                  Effect.mapError((error) => error.message),
                ),
            },
          ]
        }),
      ])
      const bind = Effect.fnUntraced(function* () {
        const record = yield* external.get(sessionID)
        if (record?.provider === provider && record.directory === directory) return record
        yield* bus.publish(ExternalSession.Bound, { sessionID, provider, directory })
        return (yield* external.get(sessionID))!
      })
      // A vendor session continues only when it holds exactly the canonical history OC++ last checkpointed.
      // Anything else (a missing or divergent vendor session, or OC++ history written by another driver) starts a
      // new vendor session rebuilt from canonical history.
      const resumable = Effect.fnUntraced(function* (record: ExternalSession.Info, settled: string) {
        if (state.vendor !== undefined) return state.vendor
        if (record.vendorSessionID === undefined || record.historyHash !== settled) return undefined
        const vendorSessionID = record.vendorSessionID
        const checkpoint = yield* Effect.tryPromise((signal) => sdk.inspect(directory, vendorSessionID, signal)).pipe(
          Effect.tapError((error) =>
            Effect.logWarning("Vendor history is unreadable; rebuilding", { sessionID, error }),
          ),
          Effect.orElseSucceed(() => undefined),
        )
        return checkpoint !== undefined && checkpoint === record.checkpoint ? vendorSessionID : undefined
      })
      // Delivering a move moves the Session: the runtime records both.
      const move = Effect.gen(function* () {
        const head = yield* peek("idle")
        if (head?.type !== "move" || !(yield* input.inbox.deliver(head.inboxID).pipe(Effect.orDie)))
          return DrainResult.Complete()
        return DrainResult.Moved({})
      })

      const scope = { next: input.promotable ?? "input" }
      while (true) {
        yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const requested = yield* Effect.gen(function* () {
              const head = yield* peek(restAt(scope.next))
              if (head?.type !== "compaction") return
              if (!(yield* input.inbox.deliver(head.inboxID).pipe(Effect.orDie))) return
              const inputID = SessionMessage.ID.make(head.inboxID)
              yield* bus.publish(SessionEvent.Compaction.Started, { sessionID, reason: "manual", recent: "", inputID })
              return inputID
            })
            if (requested === undefined) return
            yield* restore(compact("manual", requested)).pipe(
              Effect.onInterrupt(() =>
                bus.publish(SessionEvent.Compaction.Failed, {
                  sessionID,
                  reason: "manual",
                  inputID: requested,
                  error: { type: "aborted", message: "Compaction cancelled" },
                }),
              ),
            )
          }),
        )
        state.compacting = false
        const messages = yield* store.context(sessionID)
        const boundary = messages.findLast(
          (message) => message.type === "assistant" || message.type === "user" || message.type === "compaction",
        )
        // A completed automatic compaction still owes a continuation if the process stopped before the next attempt.
        if (
          !state.started &&
          input.force &&
          boundary?.type === "compaction" &&
          boundary.status === "completed" &&
          boundary.reason === "auto"
        ) {
          state.continuation = true
          state.overflow = true
        }
        const history = canonical(messages, model)
        const settled = answered(history)
        // Input admitted before a restart or failure that the vendor never answered is delivered again, once, with
        // its attachments.
        const unanswered = state.started ? [] : history.slice(settled.length).map((item) => item.input)
        state.started = true
        const record = yield* bind()
        const vendorSessionID = yield* resumable(record, Hash.sha256(JSON.stringify(settled)))
        const next = yield* take(scope.next)
        scope.next = "input"
        if (state.moved) return yield* move
        if (state.compacting) continue
        const message = ExternalAgentDriver.join([
          ...unanswered,
          next ?? (state.continuation ? [{ type: "text", text: "Continue from the restored OC++ history." }] : []),
        ])
        state.continuation = false
        if (message.length === 0) {
          const pending = yield* peek("idle")
          if (pending?.type === "compaction" || pending?.type === "move") continue
          return DrainResult.Complete()
        }
        state.idle = false
        if (!session.parentID && SessionTitle.isUntitled(session))
          yield* FiberMap.run(titles, sessionID, title.generate(sessionID), { onlyIfMissing: true })
        const checkpoint = { value: undefined as string | undefined, vendor: vendorSessionID }
        const result = yield* ExternalAgentDriver.execute(sdk, {
          directory,
          model: model.id,
          // The "default" variant is OC++'s name for no explicit effort.
          effort: model.variant === "default" ? undefined : model.variant,
          vendorSessionID,
          history: vendorSessionID === undefined ? settled : [],
          message,
          // A resumed vendor session keeps the notebook checkpoint it started with, so its instructions stay
          // identical; values saved since reach it as completion notifications. A new vendor session is rebuilt
          // from canonical history and checkpoints the notebook as it stands, which linking persists.
          harness:
            harness === "ocpp"
              ? {
                  type: "ocpp",
                  system: yield* system(
                    vendorSessionID === undefined
                      ? yield* CodeModeStore.savedNames(db, sessionID)
                      : (record.notebook ?? []),
                  ),
                }
              : { type: "native" },
          gateway,
          emit: (event) => Effect.runPromise(stream.emit(event).pipe(Effect.asVoid)),
          linked: (id) => {
            checkpoint.vendor = id
            return id === record.vendorSessionID
              ? Promise.resolve()
              : Effect.runPromise(
                  bus.publish(ExternalSession.Linked, { sessionID, vendorSessionID: id }).pipe(Effect.asVoid),
                )
          },
          checkpointed: async (value) => {
            checkpoint.value = value
          },
          // A run being aborted takes no further input: Effect evaluates a synchronous take before it observes an
          // already-aborted signal, which would hand the next call's input to the run it is replacing.
          next: (signal) =>
            signal.aborted ? Promise.resolve(undefined) : Effect.runPromise(take("input"), { signal }),
          idle: () => {
            state.idle = true
            Effect.runSync(ring)
          },
        }).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              yield* stream.finish(
                Exit.isSuccess(exit)
                  ? undefined
                  : Cause.hasInterruptsOnly(exit.cause)
                    ? new StepFailedError({ error: { type: "aborted", message: "Step interrupted" } })
                    : Cause.squash(exit.cause),
              )
              if (Object.keys(stream.diagnostics()).length > 0)
                yield* Effect.logDebug("External SDK diagnostics", {
                  sessionID,
                  provider,
                  events: stream.diagnostics(),
                })
              if (checkpoint.value === undefined) return
              if (Exit.isFailure(exit) && Cause.squash(exit.cause) instanceof ExternalAgentDriver.CompactionError)
                return
              yield* bus.publish(ExternalSession.Checkpointed, {
                sessionID,
                checkpoint: checkpoint.value,
                historyHash: Hash.sha256(JSON.stringify(answered(canonical(yield* store.context(sessionID), model)))),
              })
            }),
          ),
          Effect.mapError((error) => new StepFailedError({ error: toSessionError(error) })),
          Effect.result,
        )
        state.vendor = checkpoint.vendor
        state.idle = true
        if (result._tag === "Failure") {
          if (!compaction.enabled() || state.overflow || !isContextOverflow(result.failure.error.message))
            return yield* result.failure
          state.overflow = true
          yield* compact("auto")
          state.continuation = true
        }
        if (state.moved) return yield* move
      }
    }, Effect.scoped)

    return ExternalAgentHarness.Service.of({ drain })
  }),
)

/**
 * Canonical OC++ history: what the runner would show a model, lowered as the vendor receives input. Tool metadata never
 * enters it: a Code Mode trace holds machine-only values (private input, submitted output), and a completing execution
 * rewrites it after the checkpoint.
 */
function canonical(messages: ReadonlyArray<SessionMessage.Info>, model: Model.Ref) {
  const checkpoints = new Set<string>(
    messages.filter((message) => message.type === "compaction").map((message) => message.id),
  )
  return toLLMMessages(messages, model).flatMap((message) => {
    // Current instructions are rendered into each vendor run's system prompt instead.
    if (message.role === "system") return []
    const input = lower(message)
    if (input.length === 0) return []
    // A tool result belongs to the vendor turn that called the tool.
    return [
      {
        role: message.role === "user" ? ("user" as const) : ("assistant" as const),
        input,
        checkpoint: checkpoints.has(message.id ?? ""),
      },
    ]
  })
}

/**
 * The canonical history up to the vendor's last answer, as text: what a rebuilt vendor session replays and what its
 * checkpoint hashes. An earlier attachment is named where it was, not sent again: the vendor answered it once, and
 * replaying every image and PDF of a long Session into one message would outgrow what a vendor accepts.
 */
function answered(history: ReturnType<typeof canonical>): ExternalAgentDriver.History[] {
  return history
    .slice(0, history.findLastIndex((item) => item.role === "assistant" || item.checkpoint) + 1)
    .map((item) => ({
      role: item.role,
      text: item.input
        .map((part) =>
          part.type === "text" ? part.text : `[Attached file ${part.name ?? "(unnamed)"} (${part.mime}), not re-sent]`,
        )
        .join("\n"),
    }))
}

function isEnqueued(event: Bus.LogItem): event is SessionEvent.InboxEnqueued {
  return event.type === SessionEvent.InboxEnqueued.type
}

/**
 * A message as the native runner lowers it: text, each tool call's name and input, each result's model-visible
 * content, and each image or PDF attachment where it appears, with the bytes the runner would send. Reasoning stays
 * with the vendor that produced it.
 */
function lower(message: Message): ExternalAgentDriver.Input {
  return (
    message.content
      .flatMap((part): Array<string | ExternalAgentDriver.Media> => {
        if (part.type === "text") return [part.text]
        if (part.type === "tool-call") return [`\n[${part.name} call] ${JSON.stringify(part.input)}\n`]
        if (part.type === "tool-result") return [`\n[${part.name} result] ${result(part.result)}\n`]
        if (part.type !== "media") return []
        const media = ProviderShared.normalizeMedia(part)
        return [{ type: "media", mime: media.mime, data: media.base64, name: part.filename }]
      })
      // Text between attachments runs together, as a message's text always has.
      .reduce<Array<string | ExternalAgentDriver.Media>>((runs, part) => {
        const last = runs.at(-1)
        if (typeof part !== "string" || typeof last !== "string") return [...runs, part]
        return [...runs.slice(0, -1), last + part]
      }, [])
      .flatMap((run): ExternalAgentDriver.Input => {
        if (typeof run !== "string") return [run]
        return run.trim().length === 0 ? [] : [{ type: "text", text: run.trim() }]
      })
  )
}

function result(value: ToolResultValue) {
  if (value.type === "content") return text(value.value)
  if (value.type === "error")
    return Option.match(failed(value.value), {
      onNone: () => "Failed.",
      onSome: (failure) => [failure.error.message, ...failure.content.flatMap((part) => part.text ?? [])].join("\n"),
    })
  return typeof value.value === "string" ? value.value : JSON.stringify(value.value)
}
// A failed call's model-visible result: its error message and whatever text it returned.
const failed = Schema.decodeUnknownOption(
  Schema.Struct({
    error: Schema.Struct({ message: Schema.String }),
    content: Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  }),
)

function text(content: string | ReadonlyArray<Tool.Content> | undefined) {
  if (content === undefined) return "Completed."
  if (typeof content === "string") return content
  return (
    content.map((part) => (part.type === "text" ? part.text : `[${part.mime} attachment]`)).join("\n") || "Completed."
  )
}

export const node = makeLocationNode({
  service: ExternalAgentHarness.Service,
  layer,
  deps: [
    Bus.node,
    CodeModeStore.node,
    Database.node,
    SessionStore.node,
    ExternalAgentSession.node,
    SessionContext.node,
    SessionCompaction.node,
    ExternalAgentDrivers.node,
    SessionTitle.node,
  ],
})
