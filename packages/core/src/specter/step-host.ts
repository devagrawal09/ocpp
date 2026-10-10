export * as SpecterStepHost from "./step-host.js"

import { Cause, Clock, Context, Effect, Exit, Fiber, FiberMap, Layer } from "effect"
import { LLMClient, Message } from "@ocpp/ai"
import { Event } from "@ocpp/schema/event"
import { makeLocationNode } from "@ocpp/util/effect/app-node"
import type { SessionError } from "@ocpp/schema/session-error"
import {
  StepHost,
  type AttemptOutcome,
  type AttemptRecorder,
  type CompactFirst,
  type CompactionOutcome,
  type DriveOutcome,
  type PrepareOutcome,
  type RecordFailure,
  type StepPlan,
} from "@ocpp/session-runtime"
import { Bus } from "../bus.js"
import { ExternalAgentHarness } from "../external-agent/harness.js"
import { Database } from "../database/database.js"
import { llmClient } from "../effect/app-node-platform.js"
import { LocationServiceMap } from "../location-service-map.js"
import { Snapshot } from "../snapshot.js"
import { SessionCompaction } from "../session/compaction.js"
import { SessionContext } from "../session/context.js"
import { StepFailedError, UserInterruptedError } from "../session/error.js"
import { SessionEvent } from "../session/event.js"
import { SessionMessage } from "../session/message.js"
import { SessionModelTransport } from "../session/model-transport.js"
import { InstructionState } from "../session/instruction-state.js"
import { SessionModelRequest } from "../session/model-request.js"
import { MAX_STEPS_PROMPT } from "../session/runner/max-steps.js"
import { SessionRunnerRetry } from "../session/runner/retry.js"
import { settleStaleToolCalls } from "../session/runner/stale.js"
import { SessionStep } from "../session/runner/step.js"
import { SessionSchema } from "../session/schema.js"
import { SessionStore } from "../session/store.js"
import { SessionTitle } from "../session/title.js"
import { toSessionError } from "../session/to-session-error.js"
import { ToolOutput } from "../tool-output.js"
import { PluginSupervisor } from "../plugin/supervisor.js"

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
 * The Bus an attempt publishes through. Step facts go to the runtime's recorder: the step's start (OC++
 * starts it at the provider's first event), a finished block, a requested call, a settled call. The step's
 * end is the runtime's to settle from the attempt's outcome, so it is kept for the outcome. Everything
 * else, ephemeral deltas and progress included, reaches the real Bus.
 */
// Command payloads carry no undefined values; an absent field stays absent.
const defined = <T extends Record<string, unknown>>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as T

const recordingBus = (bus: Bus.Interface, record: AttemptRecorder) => {
  const names = new Map<string, string>()
  // A call's raw input, and the calls the model completed: a failure of any other is its input's.
  const texts = new Map<string, string>()
  const called = new Set<string>()
  const reasoningStates = new Map<number, Record<string, unknown> | undefined>()
  const settled: { started: boolean; ended?: StepEnded; failed?: StepFailed } = { started: false }
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
      case SessionEvent.Step.Started.type:
        settled.started = true
        return recorded(record.started())
      case SessionEvent.Step.Streamed.type:
        return recorded(record.streamed())
      case SessionEvent.Tool.Input.Started.type:
        names.set(data.id, data.name)
        return Effect.void
      case SessionEvent.Tool.Input.Ended.type:
        texts.set(data.id, data.text)
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
        called.add(data.id)
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
      case SessionEvent.Tool.Failed.type: {
        const { sessionID: _, assistantMessageID: __, ...result } = data
        if (called.has(data.id)) return recorded(record.toolSettled(defined(result)))
        // Its input never became a call.
        const { resultState: ___, ...failure } = result
        return recorded(
          record.toolInputFailed(
            defined({ ...failure, name: names.get(data.id) ?? "unknown", text: texts.get(data.id) }),
          ),
        )
      }
      case SessionEvent.Tool.Success.type: {
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
          // A record that began completes: the Bus notifies listeners interruptibly, so stopping the attempt
          // mid-record would cut short the uninterruptible tail that records what the attempt produced.
          yield* recordFact(definition.type, data).pipe(
            Effect.orDie,
            Effect.forkChild,
            Effect.flatMap(Fiber.join),
            Effect.uninterruptible,
          )
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

const CONTINUE_AFTER_INCOMPLETE_STREAM =
  "The previous response was interrupted. Continue from where you left off without repeating completed content."

const observed = (step: StepEnded | StepFailed) => ({
  ...(step.rawFinish === undefined ? {} : { rawFinish: step.rawFinish }),
  ...(step.providerState === undefined ? {} : { providerState: step.providerState }),
  ...(step.cost === undefined ? {} : { cost: step.cost }),
  ...(step.tokens === undefined ? {} : { tokens: step.tokens }),
  ...(step.snapshot === undefined ? {} : { snapshot: step.snapshot }),
  ...(step.files === undefined ? {} : { files: step.files }),
})

// OC++'s retry policy bounds a step's retries itself (SessionRunnerRetry), so the runtime's does not.
const RETRY_LIMIT = 1_000

const failed = (error: SessionError.Error, retryable = false, retryDelay?: number) =>
  ({
    outcome: "failed",
    error,
    retryable,
    ...(retryDelay === undefined ? {} : { retryDelay }),
    ...(retryable ? { limit: RETRY_LIMIT } : {}),
  }) as const

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
      /** The step's number since input was last delivered, from 1. */
      readonly step: number
      /** Which attempt of that step this is, from 1. */
      readonly attempt: number
    }) => Effect.Effect<StepPlan | CompactFirst>
    readonly compact: (input: {
      readonly sessionID: SessionSchema.ID
      readonly reason: "auto" | "manual"
      readonly inputID?: SessionMessage.ID
    }) => Effect.Effect<CompactionOutcome>
    /** Brings the Session's context up to date before input is delivered. */
    readonly prepare: (sessionID: SessionSchema.ID) => Effect.Effect<PrepareOutcome>
    /** Releases the Session's model transport here before it moves to another Location. */
    readonly moving: (sessionID: SessionSchema.ID) => Effect.Effect<void>
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
    const title = yield* SessionTitle.Service
    const titles = yield* FiberMap.make<SessionSchema.ID, void, never>()
    const transport = yield* SessionModelTransport.Service
    const store = yield* SessionStore.Service
    const plugins = yield* PluginSupervisor.Service

    // Before input is delivered: plugins are ready and instruction changes are recorded, so they precede
    // the input in history. A blocked initial instruction baseline leaves the input pending.
    const recoveries = new Map<
      SessionSchema.ID,
      { readonly retry: Effect.Success<ReturnType<typeof SessionRunnerRetry.make>>; overflow: boolean; full: boolean }
    >()
    // What prepare sampled is the next step's: its agent and model stay those the input was delivered to.
    const sampled = new Map<SessionSchema.ID, Effect.Success<ReturnType<typeof context.select>>>()
    // Samples the Session's agent and model and records its instruction changes. A blocked initial
    // instruction baseline must leave admitted input pending.
    const select = Effect.fn("SpecterStepIO.select")(function* (sessionID: SessionSchema.ID) {
      const selected = yield* context.select(sessionID)
      yield* InstructionState.prepare(db, bus, selected.instructions, sessionID)
      return selected
    })
    const prepare = Effect.fn("SpecterStepIO.prepare")(function* (sessionID: SessionSchema.ID) {
      yield* plugins.flush
      sampled.set(sessionID, yield* select(sessionID))
    })

    const begin = Effect.fn("SpecterStepIO.begin")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly assistantMessageID: SessionMessage.ID
      readonly step: number
      readonly attempt: number
    }) {
      const { sessionID, assistantMessageID } = input
      const prepared = sampled.get(sessionID)
      sampled.delete(sessionID)
      yield* plugins.flush
      // Tool calls a previous process left streaming or running fail before the Session continues.
      yield* settleStaleToolCalls(store, bus, sessionID)
      // A step without delivered input (a continuation, a retry) prepares here.
      const selected = prepared ?? (yield* select(sessionID))
      const loaded = yield* context.load(selected)
      // The history no longer fits the model: the runtime compacts before the step.
      if (compaction.required({ messages: loaded.messages, resolved: loaded.model }))
        return { compact: true } satisfies CompactFirst
      // Title generation starts once input is visible and must not delay the step.
      if (input.step === 1 && !loaded.session.parentID && SessionTitle.isUntitled(loaded.session))
        yield* FiberMap.run(titles, sessionID, title.generate(sessionID), { onlyIfMissing: true })
      const snapshot = yield* snapshots.capture()
      // On the agent's last step the model must answer without tools.
      const stepLimitReached = loaded.agent.info.steps !== undefined && input.step >= loaded.agent.info.steps

      // The logical step's retry schedule and one-time recoveries span its attempts; its first attempt
      // starts them afresh.
      const recovery = input.attempt === 1 ? undefined : recoveries.get(sessionID)
      const state = recovery ?? { retry: yield* SessionRunnerRetry.make(bus, sessionID), overflow: true, full: true }
      recoveries.set(sessionID, state)

      const attempt = (current: SessionContext.Loaded, record: AttemptRecorder) =>
        Effect.gen(function* () {
          const transcript = SessionModelRequest.baseTranscript({
            agent: current.agent.info,
            model: current.model,
            tools: current.tools,
            initial: current.initial,
            messages: current.messages,
          })
          const request = yield* context.prepare({
            scope: { session: current.session, agentID: current.agent.id, model: current.model, tools: current.tools },
            transcript: {
              system: transcript.system,
              messages: stepLimitReached
                ? [...transcript.messages, Message.assistant(MAX_STEPS_PROMPT)]
                : transcript.messages,
            },
            // Keep tool definitions on the final step to preserve the provider's cached prefix.
            toolChoice: stepLimitReached ? "none" : undefined,
            webSocket: "session",
          })
          const recording = recordingBus(bus, record)
          const steps = yield* SessionStep.make.pipe(
            Effect.provideService(Bus.Service, recording.bus),
            Effect.provideService(Snapshot.Service, snapshots),
            Effect.provideService(LLMClient.Service, llm),
            Effect.provideService(ToolOutput.Service, toolOutput),
          )
          const exit = yield* steps
            .attempt({
              sessionID,
              assistantMessageID,
              agent: current.agent.id,
              model: current.model,
              prepared: request,
              retry: (cause, error, retryable) =>
                state.retry.decide({
                  cause,
                  error,
                  agent: current.agent.id,
                  model: current.model.ref,
                  hook: request.retry,
                  retry: retryable,
                }),
              // Once per logical step each: reading the response again in full, and compacting the history
              // after the provider's context overflowed.
              recoverContinuation: state.full,
              recoverOverflow: Effect.suspend(() => {
                if (!state.overflow || !compaction.enabled()) return Effect.succeed(false)
                state.overflow = false
                return compaction
                  .compact({
                    session: current.session,
                    messages: current.messages,
                    resolved: current.model,
                    prepare: context.prepare,
                  })
                  .pipe(Effect.map((result) => result.status === "completed"))
              }),
            })
            .pipe(Effect.exit)
          return { exit, recording }
        })

      const run = (record: AttemptRecorder) =>
        Effect.gen(function* () {
          let current = loaded
          while (true) {
            const { exit, recording } = yield* attempt(current, record)
            const outcome = Exit.isSuccess(exit) ? exit.value : undefined
            if (outcome?._tag === "RecoverFull") state.full = false
            // Recovered before the attempt started its step: nothing of it stands, so the step runs again
            // here, on the history as it is now.
            if (
              (outcome?._tag === "RecoverFull" || outcome?._tag === "Compacted") &&
              !recording.settled.started &&
              !recording.stopped()
            ) {
              // As a retry does: the selection and instructions may have changed meanwhile.
              current = yield* select(sessionID).pipe(Effect.flatMap(context.load))
              continue
            }
            // The partial output stands: the step continues in a new step, told what happened.
            if (outcome?._tag === "Continue" && !recording.stopped())
              yield* bus.publish(SessionEvent.Synthetic, { sessionID, text: CONTINUE_AFTER_INCOMPLETE_STREAM })
            return outcomeOf(exit, recording)
          }
        }).pipe(
          // Reloading the history or recording the notice failed: so did the attempt.
          Effect.catch((error) => Effect.succeed<AttemptOutcome>(failed(toSessionError(error)))),
        )

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
        Effect.onError((cause) =>
          // OC++'s runner records a manual compaction that was cancelled or broke; an automatic one records its own.
          input.reason === "manual"
            ? bus
                .publish(SessionEvent.Compaction.Failed, {
                  sessionID: input.sessionID,
                  reason: "manual",
                  error: Cause.hasInterruptsOnly(cause)
                    ? { type: "aborted", message: "Compaction cancelled" }
                    : { type: "compaction.failed", message: Cause.pretty(cause) },
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
      prepare: (sessionID) =>
        prepare(sessionID).pipe(
          Effect.as<PrepareOutcome>({ outcome: "ready" }),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.succeed<PrepareOutcome>({ outcome: "failed", error: toSessionError(Cause.squash(cause)) }),
          ),
        ),
      begin: (input) => begin(input).pipe(Effect.catchCause((cause) => Effect.succeed(unprepared(cause)))),
      moving: (sessionID) => transport.close(sessionID),
      compact: (input) =>
        compact(input).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.succeed({
                  outcome: "failed",
                  error: toSessionError(Cause.squash(cause)),
                  fatal: true,
                } as const),
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
    SessionModelTransport.node,
    SessionStore.node,
    SessionTitle.node,
    Snapshot.node,
    ToolOutput.node,
    Database.node,
    PluginSupervisor.node,
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
  const bus = yield* Bus.Service
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
          io.begin({
            sessionID,
            assistantMessageID: SessionMessage.ID.make(input.assistantMessageID),
            step: input.step,
            attempt: input.attempt,
          }),
        ).pipe(Effect.provide(location))
        if ("compact" in plan) return plan
        // The attempt runs in the Session's Location too.
        return { ...plan, run: (record: AttemptRecorder) => plan.run(record).pipe(Effect.provide(location)) }
      }).pipe(Effect.catchCause((cause) => Effect.succeed(unprepared(cause)))),
    prepare: (sessionID) =>
      locationOf(SessionSchema.ID.make(sessionID)).pipe(
        Effect.flatMap((location) =>
          StepIO.use((io) => io.prepare(SessionSchema.ID.make(sessionID))).pipe(Effect.provide(location)),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.succeed<PrepareOutcome>({ outcome: "failed", error: toSessionError(Cause.squash(cause)) }),
        ),
      ),
    // An external agent's execution, whole: the harness delivers its input and records what the agent does. A
    // move continues it in the Session's new Location.
    drive: (input) =>
      Effect.gen(function* () {
        const sessionID = SessionSchema.ID.make(input.sessionID)
        let force = true
        while (true) {
          const location = yield* locationOf(sessionID)
          const result = yield* ExternalAgentHarness.Service.use((harness) =>
            harness.drain({ sessionID, force, promotable: input.continues ? "steer" : "input", inbox: input.inbox }),
          ).pipe(Effect.provide(location))
          if (result._tag === "Complete") return { outcome: "succeeded" } satisfies DriveOutcome
          force = false
        }
      }).pipe(
        Effect.catchCause((cause): Effect.Effect<DriveOutcome> => {
          if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
          const failure = Cause.squash(cause)
          // A dismissed question interrupts the turn on the user's behalf.
          if (failure instanceof UserInterruptedError) return Effect.succeed({ outcome: "interrupted" })
          return Effect.succeed({ outcome: "failed", error: toSessionError(failure) })
        }),
      ),
    // A dead attempt's tool calls fail as OC++'s runner failed them, naming the child Session a delegation ran.
    recover: (sessionID) => settleStaleToolCalls(store, bus, SessionSchema.ID.make(sessionID)).pipe(Effect.orDie),
    moving: (sessionID) =>
      locationOf(SessionSchema.ID.make(sessionID)).pipe(
        Effect.flatMap((location) =>
          StepIO.use((io) => io.moving(SessionSchema.ID.make(sessionID))).pipe(Effect.provide(location)),
        ),
        // Releasing a transport is best effort: the move goes ahead.
        Effect.catchCause((cause) => Effect.logWarning("Could not release the model transport", { cause })),
      ),
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
        // The provider sent nothing: no step started, and the runtime records none.
        if (!recording.settled.started) return { outcome: "succeeded", finish: "unknown", continue: false }
        if (!ended) return failed({ type: "step.unsettled", message: "The step completed without ending" })
        return {
          outcome: "succeeded",
          finish: ended.finish === "error" ? "unknown" : ended.finish,
          continue: outcome.needsContinuation,
          ...observed(ended),
        }
      case "Retry":
        return failed(outcome.error, true, outcome.decision.delay)
      // The partial output stands: the retry runs as a new step.
      case "Continue":
        return {
          ...failed(outcome.error, true, outcome.decision.delay),
          fresh: true,
          ...(stepFailed ? observed(stepFailed) : {}),
        }
      // After the step started: it runs again at once, in full.
      case "RecoverFull":
        return failed({ type: "provider.transport", message: "The response stream must be read again" }, true, 0)
      // The history was compacted under the started step: the step runs again as a new one, after it.
      case "Compacted":
        return {
          ...failed(
            { type: "context.overflow", message: "The history was compacted after the context overflowed" },
            true,
            0,
          ),
          fresh: true,
        }
    }
  }
  // Interrupted, and only that. Having recorded its step's interruption, the attempt stopped for the
  // user (a dismissed question); otherwise the execution moved on. A defect beside interrupted fibers is a
  // failure.
  if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause))
    return stepFailed?.error.type === "aborted" ? { outcome: "interrupted" } : { outcome: "stopped" }
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
