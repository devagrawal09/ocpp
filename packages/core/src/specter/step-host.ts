export * as SpecterStepHost from "./step-host.js"

import { Cause, Clock, Context, Effect, Exit, Layer } from "effect"
import { LLMClient } from "@ocpp/ai"
import { Event } from "@ocpp/schema/event"
import { makeLocationNode } from "@ocpp/util/effect/app-node"
import type { SessionError } from "@ocpp/schema/session-error"
import {
  StepHost,
  type AttemptOutcome,
  type AttemptRecorder,
  type CompactFirst,
  type CompactionOutcome,
  type RecordFailure,
  type StepPlan,
} from "@specter/agent-runtime"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { llmClient } from "../effect/app-node-platform.js"
import { LocationServiceMap } from "../location-service-map.js"
import { Snapshot } from "../snapshot.js"
import { SessionCompaction } from "../session/compaction.js"
import { SessionContext } from "../session/context.js"
import { StepFailedError } from "../session/error.js"
import { SessionEvent } from "../session/event.js"
import { SessionMessage } from "../session/message.js"
import { InstructionState } from "../session/instruction-state.js"
import { SessionModelRequest } from "../session/model-request.js"
import { SessionRunnerRetry } from "../session/runner/retry.js"
import { SessionStep } from "../session/runner/step.js"
import { SessionSchema } from "../session/schema.js"
import { SessionStore } from "../session/store.js"
import { toSessionError } from "../session/to-session-error.js"
import { ToolOutput } from "../tool-output.js"

type StepEnded = typeof SessionEvent.Step.Ended.data.Type
type StepFailed = typeof SessionEvent.Step.Failed.data.Type

// The step facts OC++'s attempt publishes. In a runtime-run Session they are the runtime's to record.
const stepFacts = new Set<string>(
  [
    SessionEvent.Step.Started,
    SessionEvent.Step.Streamed,
    SessionEvent.Step.Ended,
    SessionEvent.Step.Failed,
    SessionEvent.Text.Started,
    SessionEvent.Text.Ended,
    SessionEvent.Reasoning.Started,
    SessionEvent.Reasoning.Ended,
    SessionEvent.Tool.Input.Started,
    SessionEvent.Tool.Input.Ended,
    SessionEvent.Tool.Called,
    SessionEvent.Tool.Success,
    SessionEvent.Tool.Failed,
    SessionEvent.RetryScheduled,
  ].map((definition) => definition.type),
)

/**
 * The Bus an attempt publishes through. Step facts go to the runtime's recorder: a finished block, a
 * requested call, a settled call. The step's own start and end are the runtime's (it recorded the start
 * and settles the step from the attempt's outcome), so the end is kept for the outcome. Everything else,
 * ephemeral deltas and progress included, reaches the real Bus.
 */
// Command payloads carry no undefined values; an absent field stays absent.
const defined = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T

const recordingBus = (bus: Bus.Interface, record: AttemptRecorder) => {
  const names = new Map<string, string>()
  const reasoningStates = new Map<number, Record<string, unknown> | undefined>()
  const settled: { ended?: StepEnded; failed?: StepFailed } = {}
  // Once the runtime rejects a record, the execution moved on: nothing more is recorded.
  let stopped = false
  const recorded = (effect: Effect.Effect<boolean, RecordFailure>) =>
    stopped
      ? Effect.void
      : effect.pipe(
          Effect.map((accepted) => {
            if (!accepted) stopped = true
          }),
        )

  const recordFact = (type: string, data: any): Effect.Effect<void, RecordFailure> => {
    switch (type) {
      case SessionEvent.Tool.Input.Started.type:
        names.set(data.id, data.name)
        return Effect.void
      case SessionEvent.Reasoning.Started.type:
        reasoningStates.set(data.ordinal, data.state)
        return Effect.void
      case SessionEvent.Text.Ended.type:
        return recorded(
          record.block(defined({ kind: "text", ordinal: data.ordinal, text: data.text, state: data.state })),
        )
      case SessionEvent.Reasoning.Ended.type: {
        return recorded(
          record.block(
            defined({
              kind: "reasoning",
              ordinal: data.ordinal,
              text: data.text,
              state: data.state ?? reasoningStates.get(data.ordinal),
            }),
          ),
        )
      }
      case SessionEvent.Tool.Called.type:
        return recorded(
          record.toolRequested(
            defined({
              id: data.id,
              name: names.get(data.id) ?? "unknown",
              input: data.input,
              executed: data.executed,
              state: data.state,
            }),
          ),
        )
      case SessionEvent.Tool.Success.type:
      case SessionEvent.Tool.Failed.type: {
        const { sessionID: _, assistantMessageID: __, ...result } = data
        return recorded(record.toolSettled(defined(result)))
      }
      case SessionEvent.Step.Ended.type:
        settled.ended = data
        return Effect.void
      case SessionEvent.Step.Failed.type:
        settled.failed = data
        return Effect.void
      default:
        return Effect.void
    }
  }

  const publish: Bus.Interface["publish"] = (definition, data, options) =>
    stepFacts.has(definition.type)
      ? Effect.gen(function* () {
          yield* recordFact(definition.type, data).pipe(Effect.orDie)
          return {
            id: options?.id ?? Event.ID.create(),
            created: yield* Clock.currentTimeMillis,
            type: definition.type,
            data,
          } as never
        })
      : bus.publish(definition, data, options)

  return { bus: { ...bus, publish }, settled, stopped: () => stopped }
}

const observed = (step: StepEnded | StepFailed) => ({
  ...(step.rawFinish === undefined ? {} : { rawFinish: step.rawFinish }),
  ...(step.providerState === undefined ? {} : { providerState: step.providerState }),
  ...(step.cost === undefined ? {} : { cost: step.cost }),
  ...(step.tokens === undefined ? {} : { tokens: step.tokens }),
  ...(step.snapshot === undefined ? {} : { snapshot: step.snapshot }),
  ...(step.files === undefined ? {} : { files: step.files }),
})

const failed = (error: SessionError.Error, retryable = false, retryDelay?: number): AttemptOutcome => ({
  outcome: "failed",
  error,
  retryable,
  ...(retryDelay === undefined ? {} : { retryDelay }),
})

/**
 * OC++'s step I/O in one Location: the request OC++ builds for a Session (system prompt, instructions,
 * agent, tools and history from OC++'s own projections), the model stream, tool execution and snapshots.
 */
export class StepIO extends Context.Service<
  StepIO,
  {
    readonly begin: (input: {
      readonly sessionID: SessionSchema.ID
      readonly assistantMessageID: SessionMessage.ID
    }) => Effect.Effect<StepPlan | CompactFirst>
    readonly compact: (input: {
      readonly sessionID: SessionSchema.ID
      readonly reason: "auto" | "manual"
      readonly inputID?: SessionMessage.ID
    }) => Effect.Effect<CompactionOutcome>
  }
>()("@ocpp/SpecterStepIO") {}

const stepIOLayer = Layer.effect(
  StepIO,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const context = yield* SessionContext.Service
    const snapshots = yield* Snapshot.Service
    const db = (yield* Database.Service).db
    const llm = yield* LLMClient.Service
    const toolOutput = yield* ToolOutput.Service
    const compaction = yield* SessionCompaction.Service
    const store = yield* SessionStore.Service

    const begin = Effect.fn("SpecterStepIO.begin")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly assistantMessageID: SessionMessage.ID
    }) {
      const { sessionID, assistantMessageID } = input
      const selected = yield* context.select(sessionID)
      // A blocked initial instruction baseline must leave admitted input pending.
      yield* InstructionState.prepare(db, bus, selected.instructions, sessionID)
      const loaded = yield* context.load(selected)
      // The history no longer fits the model: the runtime compacts before the step.
      if (compaction.required({ messages: loaded.messages, resolved: loaded.model }))
        return { compact: true } satisfies CompactFirst
      const snapshot = yield* snapshots.capture()

      const run = (record: AttemptRecorder) =>
        Effect.gen(function* () {
          const transcript = SessionModelRequest.baseTranscript({
            agent: loaded.agent.info,
            model: loaded.model,
            tools: loaded.tools,
            initial: loaded.initial,
            messages: loaded.messages,
          })
          const request = yield* context.prepare({
            scope: { session: loaded.session, agentID: loaded.agent.id, model: loaded.model, tools: loaded.tools },
            transcript: { system: transcript.system, messages: transcript.messages },
            webSocket: "session",
          })
          const recording = recordingBus(bus, record)
          const steps = yield* SessionStep.make.pipe(
            Effect.provideService(Bus.Service, recording.bus),
            Effect.provideService(Snapshot.Service, snapshots),
            Effect.provideService(LLMClient.Service, llm),
            Effect.provideService(ToolOutput.Service, toolOutput),
          )
          const retry = yield* SessionRunnerRetry.make(bus, sessionID)
          const exit = yield* steps
            .attempt({
              sessionID,
              assistantMessageID,
              agent: loaded.agent.id,
              model: loaded.model,
              prepared: request,
              retry: (cause, error, retryable) =>
                retry.decide({
                  cause,
                  error,
                  agent: loaded.agent.id,
                  model: loaded.model.ref,
                  hook: request.retry,
                  retry: retryable,
                }),
              // Transparent recovery and overflow compaction are the runtime's to decide (later).
              recoverContinuation: false,
              recoverOverflow: Effect.succeed(false),
            })
            .pipe(Effect.exit)
          return outcomeOf(exit, recording)
        })

      return {
        agent: loaded.agent.id,
        model: { id: loaded.model.ref.id, providerID: loaded.model.ref.providerID },
        ...(snapshot === undefined ? {} : { snapshot }),
        run,
      } satisfies StepPlan
    })

    // OC++'s own compaction, publishing its facts (started, ended or failed, usage) as it always has.
    const compact = Effect.fn("SpecterStepIO.compact")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly reason: "auto" | "manual"
      readonly inputID?: SessionMessage.ID
    }) {
      const session = yield* store.get(input.sessionID)
      if (!session) return yield* Effect.die(new Error(`Session not found: ${input.sessionID}`))
      const messages = yield* store.context(input.sessionID)
      const run =
        input.reason === "manual" && input.inputID !== undefined
          ? compaction.compactManual({
              session,
              messages,
              inputID: input.inputID,
              resolveModel: context.resolveModel,
              prepare: context.prepare,
            })
          : context
              .resolveModel(session)
              .pipe(
                Effect.flatMap((resolved) =>
                  compaction.compact({ session, messages, resolved, prepare: context.prepare }),
                ),
              )
      const outcome = yield* run.pipe(
        Effect.onInterrupt(() =>
          // OC++'s runner records a cancelled manual compaction; an automatic one records its own.
          input.reason === "manual"
            ? bus
                .publish(SessionEvent.Compaction.Failed, {
                  sessionID: input.sessionID,
                  reason: "manual",
                  error: { type: "aborted", message: "Compaction cancelled" },
                  inputID: input.inputID,
                })
                .pipe(Effect.asVoid)
            : Effect.void,
        ),
      )
      return outcome.status === "completed"
        ? ({ outcome: "completed" } as const)
        : ({ outcome: "failed", error: outcome.error } as const)
    })

    return StepIO.of({
      begin: (input) => begin(input).pipe(Effect.catchCause((cause) => Effect.succeed(unprepared(cause)))),
      compact: (input) =>
        compact(input).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.succeed({ outcome: "failed", error: toSessionError(Cause.squash(cause)) } as const),
          ),
        ),
    })
  }),
)

export const stepIONode = makeLocationNode({
  service: StepIO,
  layer: stepIOLayer,
  deps: [
    Bus.node,
    llmClient,
    SessionContext.node,
    SessionCompaction.node,
    SessionStore.node,
    Snapshot.node,
    ToolOutput.node,
    Database.node,
  ],
})

// A step whose request cannot be prepared fails at once; what is recorded is all OC++ knows.
const unprepared = (cause: Cause.Cause<unknown>): StepPlan => ({
  agent: "build",
  model: { id: "unknown", providerID: "unknown" },
  run: () => Effect.succeed(failed(toSessionError(Cause.squash(cause)))),
})

/**
 * OC++'s step I/O for the runtime that runs Sessions, in each Session's Location. The runtime owns
 * everything around it.
 */
export const make = Effect.gen(function* () {
  const store = yield* SessionStore.Service
  const locations = yield* LocationServiceMap.Service
  const locationOf = (sessionID: SessionSchema.ID) =>
    store
      .get(sessionID)
      .pipe(
        Effect.flatMap((session) =>
          session
            ? Effect.succeed(locations.get(session.location))
            : Effect.die(new Error(`Session not found: ${sessionID}`)),
        ),
      )
  return StepHost.of({
    begin: (input) =>
      Effect.gen(function* () {
        const sessionID = SessionSchema.ID.make(input.sessionID)
        const location = yield* locationOf(sessionID)
        const plan = yield* StepIO.use((io) =>
          io.begin({ sessionID, assistantMessageID: SessionMessage.ID.make(input.assistantMessageID) }),
        ).pipe(Effect.provide(location))
        if ("compact" in plan) return plan
        // The attempt runs in the Session's Location too.
        return { ...plan, run: (record: AttemptRecorder) => plan.run(record).pipe(Effect.provide(location)) }
      }).pipe(Effect.catchCause((cause) => Effect.succeed(unprepared(cause)))),
    compact: (input) =>
      Effect.gen(function* () {
        const sessionID = SessionSchema.ID.make(input.sessionID)
        const location = yield* locationOf(sessionID)
        return yield* StepIO.use(
          (io): Effect.Effect<CompactionOutcome> =>
            io.compact({
              sessionID,
              reason: input.reason,
              ...(input.inputID === undefined ? {} : { inputID: SessionMessage.ID.make(input.inputID) }),
            }),
        ).pipe(Effect.provide(location))
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed<CompactionOutcome>(
            Cause.hasInterruptsOnly(cause)
              ? { outcome: "stopped" }
              : { outcome: "failed", error: toSessionError(Cause.squash(cause)) },
          ),
        ),
      ),
  })
})

export const layer = Layer.effect(StepHost, make)

/** How an OC++ attempt ended, as the runtime records it. */
const outcomeOf = (
  exit: Exit.Exit<SessionStep.Outcome, unknown>,
  recording: ReturnType<typeof recordingBus>,
): AttemptOutcome => {
  if (recording.stopped()) return { outcome: "stopped" }
  const { ended, failed: stepFailed } = recording.settled
  if (Exit.isSuccess(exit)) {
    const outcome = exit.value
    switch (outcome._tag) {
      case "Completed":
        if (!ended) return failed({ type: "step.unsettled", message: "The step completed without ending" })
        return {
          outcome: "succeeded",
          finish: ended.finish === "error" ? "unknown" : ended.finish,
          continue: outcome.needsContinuation,
          ...observed(ended),
        }
      case "Retry":
        return failed(outcome.error, true, outcome.decision.delay)
      case "Continue":
        return {
          ...failed(outcome.error, true, outcome.decision.delay),
          ...(stepFailed ? observed(stepFailed) : {}),
        }
      case "RecoverFull":
        return failed({ type: "provider.transport", message: "The response stream must be read again" }, true)
      case "Compacted":
        return failed({ type: "compaction.unexpected", message: "The attempt compacted unexpectedly" })
    }
  }
  if (Exit.hasInterrupts(exit) && !stepFailed) return { outcome: "stopped" }
  if (stepFailed)
    return {
      outcome: "failed",
      error: stepFailed.error,
      retryable: false,
      ...(stepFailed.finish === undefined ? {} : { finish: stepFailed.finish }),
      ...observed(stepFailed),
    }
  const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
  return failed(error instanceof StepFailedError ? error.error : toSessionError(error))
}
