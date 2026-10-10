import type { SessionError } from "@ocpp/schema/session-error"
import { Effect, Layer } from "effect"

import { type AttemptOutcome, StepHost } from "../../src/plugins/step-host.ts"

// A host's step I/O without a model: each attempt plays the next scripted
// step of its Session through the runtime's AttemptRecorder, as a host's
// model and tools would.
export type ScriptedStep = {
  // The attempt stays in flight, once started, until this settles.
  readonly gate?: Promise<void>
  readonly text?: string
  // Requested before any of them runs, then settled one at a time.
  readonly toolCalls?: readonly ScriptedCall[]
} & (
  | { readonly finish: "tool-calls" | "stop" | "length" | "unknown" }
  // A failed attempt; whether a retry is worth it is the host's call.
  | {
      readonly finish: "error"
      readonly retryable: boolean
      readonly error: SessionError.Error
    }
)

export type ScriptedCall = {
  readonly id: string
  readonly name: string
  readonly input?: Record<string, unknown>
  // The call runs until this settles, then succeeds.
  readonly gate?: Promise<void>
}

export const makeScriptedStepHost = (options: { readonly agent?: string } = {}) => {
  const queues = new Map<string, ScriptedStep[]>()
  const stopped = { outcome: "stopped" } as const
  const host = StepHost.of({
    compact: () =>
      Effect.succeed({
        outcome: "failed",
        error: { type: "compaction.unavailable", message: "This host cannot compact a Session" },
      } as const),
    begin: ({ sessionID }) =>
      Effect.succeed({
        agent: options.agent ?? "build",
        model: { id: "scripted", providerID: "test" },
        run: (record) =>
          Effect.gen(function* () {
            if (!(yield* record.started())) return stopped
            // An exhausted script ends the execution rather than looping forever.
            const { gate, ...step }: ScriptedStep = queues.get(sessionID)?.shift() ?? { finish: "stop" }
            if (gate) yield* Effect.promise(() => gate)
            if (step.finish === "error")
              return { outcome: "failed", error: step.error, retryable: step.retryable } satisfies AttemptOutcome
            if (step.text && !(yield* record.block({ kind: "text", ordinal: 0, text: step.text }))) return stopped
            const calls = step.toolCalls ?? []
            for (const call of calls)
              if (!(yield* record.toolRequested({ id: call.id, name: call.name, input: call.input ?? {} })))
                return stopped
            for (const call of calls) {
              yield* Effect.promise(() => call.gate ?? Promise.resolve())
              if (!(yield* record.toolSettled({ id: call.id, content: [{ type: "text", text: "ok" }] }))) return stopped
            }
            return {
              outcome: "succeeded",
              finish: step.finish,
              continue: step.finish === "tool-calls",
            } satisfies AttemptOutcome
          }),
      }),
  })
  return {
    host,
    layer: Layer.succeed(StepHost, host),
    script: (sessionID: string, steps: readonly ScriptedStep[]) => {
      queues.set(sessionID, [...(queues.get(sessionID) ?? []), ...steps])
    },
  }
}

export type ScriptedStepHost = ReturnType<typeof makeScriptedStepHost>
