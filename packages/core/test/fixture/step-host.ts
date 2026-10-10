export * as TestStepHost from "./step-host"

import { StepHost, type AttemptOutcome } from "@ocpp/session-runtime"
import type { SessionError } from "@ocpp/schema/session-error"
import { Session } from "@ocpp/core/session"
import { SessionExecution } from "@ocpp/core/session/execution"
import type { SessionSchema } from "@ocpp/core/session/schema"
import { SessionStore } from "@ocpp/core/session/store"
import { Bus } from "@ocpp/core/bus"
import { Job } from "@ocpp/core/job"
import { LocationServiceMap } from "@ocpp/core/location-service-map"
import { SpecterStepHost } from "@ocpp/core/specter/step-host"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { type Context, Effect, Layer, Option } from "effect"

/** One step as an attempt plays it through the runtime's recorder: what it records, then how it ends. */
export type Step = {
  /** Recorded on the step (default `build`). */
  readonly agent?: string
  readonly model?: { readonly id: string; readonly providerID: string }
  /** The attempt stays in flight, once started, until this settles. */
  readonly gate?: Promise<void>
  /** Runs once the step has started, before it waits on its gate. */
  readonly onStarted?: () => void
  readonly text?: string
} & (
  | { readonly finish: "tool-calls" | "stop" | "length" | "unknown" }
  | { readonly finish: "error"; readonly retryable: boolean; readonly error: SessionError.Error }
)

/**
 * The runtime's step I/O for compositions that do not exercise OC++'s model requests: each attempt plays
 * the next step scripted for its Session, or else the one `step` decides. A Session with neither runs no
 * step, as if the model answered nothing, so its execution delivers the input and settles. A compaction
 * completes without recording anything.
 */
export const make = (
  options: {
    readonly step?: (sessionID: SessionSchema.ID) => Effect.Effect<Step | undefined, never, SessionStore.Service>
    /** Runs before an execution delivers input; input stays pending until it returns. */
    readonly prepare?: (sessionID: SessionSchema.ID) => Effect.Effect<void, never, SessionStore.Service>
    /** Receives the composition's services, for a test that drives work by hand the way a step would. */
    readonly capture?: { current?: Context.Context<Bus.Service | Job.Service | LocationServiceMap.Service> }
  } = {},
) => {
  const scripts = new Map<string, Step[]>()
  const parked = new Map<string, Promise<void>>()
  const compactions: Array<Parameters<StepHost["Service"]["compact"]>[0]> = []
  const script = (sessionID: string, steps: readonly Step[]) => {
    scripts.set(sessionID, [...(scripts.get(sessionID) ?? []), ...steps])
  }
  const stopped = { outcome: "stopped" } as const
  const make = Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const next = (sessionID: SessionSchema.ID) =>
      Effect.suspend(() => {
        const scripted = scripts.get(sessionID)?.shift()
        if (scripted || !options.step) return Effect.succeed(scripted)
        return options.step(sessionID).pipe(Effect.provideService(SessionStore.Service, store))
      })
    return StepHost.of({
      prepare: (sessionID) =>
        Effect.promise(() => parked.get(sessionID) ?? Promise.resolve()).pipe(
          Effect.andThen(
            options.prepare?.(sessionID as SessionSchema.ID).pipe(Effect.provideService(SessionStore.Service, store)) ??
              Effect.void,
          ),
          Effect.as({ outcome: "ready" } as const),
        ),
      compact: (input) =>
        Effect.sync(() => {
          compactions.push(input)
          return { outcome: "completed" } as const
        }),
      begin: (input) =>
        Effect.gen(function* () {
          const step = yield* next(input.sessionID as SessionSchema.ID)
          return {
            agent: step?.agent ?? "build",
            model: step?.model ?? { id: "test", providerID: "test" },
            run: (record) =>
              Effect.gen(function* () {
                if (!step) return { outcome: "succeeded", finish: "stop", continue: false } satisfies AttemptOutcome
                if (!(yield* record.started())) return stopped
                step.onStarted?.()
                yield* Effect.promise(() => step.gate ?? Promise.resolve())
                if (step.finish === "error")
                  return { outcome: "failed", error: step.error, retryable: step.retryable } satisfies AttemptOutcome
                if (step.text && !(yield* record.block({ kind: "text", ordinal: 0, text: step.text }))) return stopped
                return {
                  outcome: "succeeded",
                  finish: step.finish,
                  continue: step.finish === "tool-calls",
                } satisfies AttemptOutcome
              }),
          }
        }),
    })
  })

  const node = options.capture
    ? makeGlobalNode({
        service: StepHost,
        layer: Layer.effect(
          StepHost,
          Effect.gen(function* () {
            const capture = options.capture ?? {}
            capture.current = yield* Effect.context<Bus.Service | Job.Service | LocationServiceMap.Service>()
            return yield* make
          }),
        ),
        deps: [SessionStore.node, Bus.node, Job.node, LocationServiceMap.node],
      })
    : makeGlobalNode({ service: StepHost, layer: Layer.effect(StepHost, make), deps: [SessionStore.node] })
  return {
    script,
    /** The compactions the runtime asked for, in order. */
    compactions,
    /**
     * Holds the Session's next step in flight: `started` resolves once it is, and `release` lets it finish.
     * Input that steers waits for the step boundary meanwhile.
     */
    hold: (sessionID: string) => {
      const started = Promise.withResolvers<void>()
      const gate = Promise.withResolvers<void>()
      script(sessionID, [{ finish: "stop", gate: gate.promise, onStarted: () => started.resolve() }])
      return {
        started: Effect.promise(() => started.promise),
        release: Effect.sync(() => gate.resolve()),
      }
    },
    /**
     * Parks the Session's executions before they deliver input, until `release`: input admitted meanwhile
     * stays pending, and no step starts.
     */
    park: (sessionID: string) => {
      const gate = Promise.withResolvers<void>()
      parked.set(sessionID, gate.promise)
      return {
        release: Effect.sync(() => {
          parked.delete(sessionID)
          gate.resolve()
        }),
      }
    },
    /**
     * Starts an execution of the Session whose step stays in flight until `release`, so input admitted
     * meanwhile stays pending until the step boundary.
     */
    busy: (sessionID: SessionSchema.ID) =>
      Effect.gen(function* () {
        const started = Promise.withResolvers<void>()
        const gate = Promise.withResolvers<void>()
        script(sessionID, [{ finish: "stop", gate: gate.promise, onStarted: () => started.resolve() }])
        // Through the composition's execution, or its Session facade.
        const execution = yield* Effect.serviceOption(SessionExecution.Service)
        const sessions = yield* Effect.serviceOption(Session.Service)
        const resume = Option.isSome(execution)
          ? execution.value.resume(sessionID)
          : Option.isSome(sessions)
            ? sessions.value.resume(sessionID)
            : Effect.die(new Error("busy needs SessionExecution or Session"))
        yield* resume.pipe(Effect.ignore, Effect.forkChild)
        yield* Effect.promise(() => started.promise)
        return { release: Effect.sync(() => gate.resolve()) }
      }),
    /** Replaces OC++'s step I/O in a composition. */
    replacement: [SpecterStepHost.node, node] as const,
  }
}
