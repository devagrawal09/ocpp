import { join } from "node:path"
import {
  implementReaction,
  type CommandEnvelope,
  type ReactionDeliveryContext,
  type ReactionPluginContext,
  type SliceStoreService,
} from "@specter-ts/core"
import { createJsonlEventLog } from "@specter-ts/jsonl"
import {
  withReactionOutbox,
  type OutboxedReaction,
  type ReactionOutboxStore,
  type ReactionOutboxTransitionListener,
} from "@specter-ts/reaction-outbox"
import { createReactionSlice, event } from "@specter-ts/spec"
import { Context, Effect, Stream } from "effect"
import { executionFailed, executionSucceeded, promptDelivered, promptEnqueued, sessionCreated } from "./events"
import type { ModelPart, TurnModel } from "./fake-model"
import { sessionMessages, sessionStatus } from "./queries"

export type RunTurn = {
  type: "runTurn"
  payload: { sessionId: string; promptId: string; executionId: string }
}

type Turn = RunTurn["payload"]

/**
 * `trigger` is reset by every apply and set only by the Event that makes a turn due, so the
 * handler emits one output per transition. Without it, a prompt enqueued before the outboxed
 * turn commits `execution-started` would see an idle Session and request the same turn again.
 */
export type RunTurnState = {
  sessionId: string
  queued: string[]
  active: Turn | null
  trigger: Turn | null
}

export const createRunTurnState = (): RunTurnState => ({ sessionId: "", queued: [], active: null, trigger: null })

export const RunTurnStore = Context.Service<SliceStoreService<RunTurnState, RunTurnState, unknown>>(
  "@ocpp/session-specter/RunTurnStore",
)

/** Per-app capabilities the outboxed turn needs; supplied in the app's Layer. */
export class SessionTurns extends Context.Service<
  SessionTurns,
  {
    readonly sessionDir: string
    readonly model: TurnModel
    readonly outbox: ReactionOutboxStore<OutboxedReaction<RunTurn>>
    readonly onTransition?: ReactionOutboxTransitionListener<OutboxedReaction<RunTurn>>
    readonly metrics?: TurnMetrics
  }
>()("@ocpp/session-specter/SessionTurns") {}

export type TurnMetrics = { commitMs: number[]; tokens: number; deltaWrites: number }

const executionIdFor = (promptId: string) => `exe_${promptId}`

const created = event("session-created", { sessionId: "ses_1" })
const enqueued = event("prompt-enqueued", { promptId: "prm_1", text: "Fix the build" })
const enqueuedSecond = event("prompt-enqueued", { promptId: "prm_2", text: "Run tests" })
const runFirst = { type: "runTurn", payload: { sessionId: "ses_1", promptId: "prm_1", executionId: "exe_prm_1" } }
const deliveredFirst = event("prompt-delivered", { promptId: "prm_1", executionId: "exe_prm_1" })

export const runTurn = implementReaction(
  createReactionSlice("runTurn")
    .description("Requests one model turn when a prompt is due on an idle Session.")
    .scenarios(
      { description: "Runs the first prompt on an idle Session.", given: [created, enqueued], expect: [runFirst] },
      {
        description: "Does not request a turn again before the requested one starts.",
        given: [created, enqueued, enqueuedSecond],
        expect: [],
      },
      {
        description: "Waits while an execution runs.",
        given: [created, enqueued, deliveredFirst, enqueuedSecond],
        expect: [],
      },
      {
        description: "Runs the next queued prompt after an execution succeeds.",
        given: [
          created,
          enqueued,
          deliveredFirst,
          enqueuedSecond,
          event("execution-succeeded", { executionId: "exe_prm_1" }),
        ],
        expect: [{ type: "runTurn", payload: { sessionId: "ses_1", promptId: "prm_2", executionId: "exe_prm_2" } }],
      },
      {
        description: "Runs the next queued prompt after an execution fails.",
        given: [
          created,
          enqueued,
          deliveredFirst,
          enqueuedSecond,
          event("execution-failed", { executionId: "exe_prm_1", error: "Provider overloaded" }),
        ],
        expect: [{ type: "runTurn", payload: { sessionId: "ses_1", promptId: "prm_2", executionId: "exe_prm_2" } }],
      },
      {
        description: "Goes idle when nothing is queued.",
        given: [created, enqueued, deliveredFirst, event("execution-succeeded", { executionId: "exe_prm_1" })],
        expect: [],
      },
    ),
)
  .outputSchema<RunTurn>()
  .plugin(runTurnPlugin)
  .store(RunTurnStore)
  .apply(sessionCreated, async (event, state) => {
    state.sessionId = event.payload.sessionId
    state.trigger = null
  })
  .apply(promptEnqueued, async (event, state) => {
    state.queued.push(event.payload.promptId)
    state.trigger = null
    if (state.active) return
    state.active = {
      sessionId: state.sessionId,
      promptId: event.payload.promptId,
      executionId: executionIdFor(event.payload.promptId),
    }
    state.trigger = state.active
  })
  .apply(promptDelivered, async (event, state) => {
    state.queued = state.queued.filter((id) => id !== event.payload.promptId)
    state.trigger = null
  })
  .apply(executionSucceeded, async (_event, state) => settle(state))
  .apply(executionFailed, async (_event, state) => settle(state))
  .handle(async (state) => (state.trigger ? { type: "runTurn", payload: state.trigger } : undefined))

function settle(state: RunTurnState) {
  const next = state.queued[0]
  state.active = next ? { sessionId: state.sessionId, promptId: next, executionId: executionIdFor(next) } : null
  state.trigger = state.active
}

/**
 * Enqueues each output into the app's outbox; the scoped worker streams the model outside the
 * Reaction Slice transaction. Every Command uses a deliveryId-derived idempotency key, so an
 * attempt retried after a crash gets the first commit back as a duplicate, even when the
 * re-streamed response differs.
 */
function runTurnPlugin(capabilities: ReactionPluginContext) {
  return Effect.gen(function* () {
    // The outbox Store is per Session, so the wrapper is built per app from its Layer.
    const turns = yield* SessionTurns
    return yield* withReactionOutbox<RunTurn>(
      () => Effect.succeed((output, delivery) => executeTurn(output.payload, delivery)),
      { store: turns.outbox, worker: { leaseMs: 5 * 60_000, backoffMs: () => 100, onTransition: turns.onTransition } },
    )(capabilities)

    function executeTurn(turn: Turn, delivery: ReactionDeliveryContext) {
      const dispatch = (envelope: CommandEnvelope, step: string) =>
        Effect.gen(function* () {
          const started = performance.now()
          const receipt = yield* capabilities.command(envelope, { idempotencyKey: `${delivery.deliveryId}:${step}` })
          turns.metrics?.commitMs.push(performance.now() - started)
          return receipt
        })
      return Effect.gen(function* () {
        const start = yield* dispatch(
          { type: "startExecution", payload: { executionId: turn.executionId, promptId: turn.promptId } },
          "start",
        )
        // An earlier attempt started this turn; if it also ended it, do not stream the model again.
        if (start.duplicate && (yield* capabilities.query(sessionStatus, {})).executionId !== turn.executionId) return
        const prompt = (yield* capabilities.query(sessionMessages, {})).find((message) => message.id === turn.promptId)
        const deltas = yield* Effect.acquireRelease(
          Effect.sync(() =>
            createJsonlEventLog({ path: join(turns.sessionDir, "steps", `${turn.executionId}.jsonl`) }),
          ),
          (log) => Effect.sync(() => log.close()),
        )
        // A retried attempt appends a new marker; tail consumers drop text from earlier attempts.
        const attempts = yield* deltas.query(0, ["attempt-started"])
        yield* deltas.append([{ type: "attempt-started", payload: { attempt: attempts.length + 1 } }])
        const text: string[] = []
        const calls: Extract<ModelPart, { type: "tool-call" }>[] = []
        // Arrival-driven coalescing like OC++'s 100 ms batcher: append pending tokens once 50 ms
        // passed since the last append, at tool-call boundaries, and when the stream ends.
        // Stream.groupedWithin did the same with a timer but cost ~5x more CPU per token.
        const window = { flushed: 0, at: performance.now() }
        const flush = Effect.suspend(() => {
          const pending = text.slice(window.flushed)
          window.flushed = text.length
          window.at = performance.now()
          if (pending.length === 0) return Effect.void
          if (turns.metrics) {
            turns.metrics.tokens += pending.length
            turns.metrics.deltaWrites += 1
          }
          return deltas.append([{ type: "text-delta", payload: { delta: pending.join("") } }])
        })
        const streamed = yield* Effect.result(
          turns.model
            .stream({ executionId: turn.executionId, prompt: prompt?.role === "user" ? prompt.text : "" })
            .pipe(
              Stream.runForEach((part) => {
                if (part.type === "tool-call") {
                  calls.push(part)
                  return flush
                }
                text.push(part.text)
                return performance.now() - window.at >= 50 ? flush : Effect.void
              }),
            ),
        )
        yield* flush
        if (streamed._tag === "Failure") {
          yield* deltas.append([{ type: "step-failed", payload: { error: streamed.failure.message } }])
          yield* dispatch(
            { type: "failExecution", payload: { executionId: turn.executionId, error: streamed.failure.message } },
            "fail",
          )
          return
        }
        yield* deltas.append([{ type: "step-ended", payload: { length: text.join("").length } }])
        const messageId = `msg_${turn.executionId}`
        if (text.length > 0)
          yield* dispatch(
            {
              type: "recordText",
              payload: { executionId: turn.executionId, messageId, ordinal: 0, text: text.join("") },
            },
            "text:0",
          )
        yield* Effect.forEach(
          calls,
          (call) =>
            Effect.gen(function* () {
              yield* dispatch(
                {
                  type: "recordToolCall",
                  payload: {
                    executionId: turn.executionId,
                    messageId,
                    callId: call.callId,
                    tool: call.tool,
                    input: call.input,
                  },
                },
                `tool:${call.callId}`,
              )
              yield* dispatch(
                {
                  type: "recordToolResult",
                  payload: {
                    executionId: turn.executionId,
                    callId: call.callId,
                    output: `contents of ${call.input.path}`,
                  },
                },
                `tool-result:${call.callId}`,
              )
            }),
          { discard: true },
        )
        yield* dispatch({ type: "completeExecution", payload: { executionId: turn.executionId } }, "complete")
      }).pipe(Effect.scoped)
    }
  })
}
