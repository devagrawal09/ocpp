export * as ExternalAgentDriver from "./driver.js"

import { Effect, Schema } from "effect"
import type { ExternalSession } from "@opencode-ai/schema/external-session"
import type { ExternalAgentGateway } from "./gateway.js"

export type Event =
  | { readonly type: "status"; readonly status: "running" | "compacting" | "retrying"; readonly attempt?: number }
  | { readonly type: "step-start"; readonly id: string }
  | { readonly type: "text" | "reasoning"; readonly id: string; readonly delta: string }
  | { readonly type: "tool-start"; readonly id: string; readonly name: string; readonly input: Record<string, unknown> }
  | { readonly type: "tool-progress"; readonly id: string; readonly metadata: Record<string, Schema.Json> }
  | { readonly type: "tool-end"; readonly id: string; readonly output: string; readonly error?: boolean }
  | {
      readonly type: "usage"
      readonly input: number
      readonly output: number
      readonly cacheRead: number
      readonly cacheWrite?: number
      readonly reasoning?: number
      readonly cost?: number
    }
  | { readonly type: "step-end" }
  | { readonly type: "diagnostic"; readonly name: string }

export interface History {
  readonly role: "user" | "assistant"
  readonly text: string
}
export interface Options {
  readonly directory: string
  readonly model: string
  readonly effort?: string
  readonly vendorSessionID?: string
  readonly checkpoint?: string
  readonly history: ReadonlyArray<History>
  readonly message: string
  readonly gateway: ExternalAgentGateway.Gateway
  readonly signal: AbortSignal
  readonly authorize: (
    name: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
    toolID?: string,
    cwd?: string,
  ) => Promise<void>
  readonly emit: (event: Event) => Promise<void>
  readonly linked: (id: string) => Promise<void>
  readonly checkpointed: (checkpoint: string) => Promise<void>
}
export interface Driver {
  readonly provider: ExternalSession.Provider
  readonly inspect: (directory: string, id: string, signal: AbortSignal) => Promise<string | undefined>
  readonly run: (options: Options) => Promise<void>
}
export class Error extends Schema.TaggedError<Error>()("ExternalAgent.Error", { message: Schema.String }) {}

export function replay(history: ReadonlyArray<History>) {
  return history.map((item) => `${item.role}:\n${item.text}`).join("\n\n")
}

export function check(expected: string | undefined, actual: string) {
  if (expected === undefined || expected !== actual)
    throw new Error({ message: "Vendor history diverged from the last OpenCode checkpoint. Resume was refused." })
}

/** Interruption waits for the SDK to relinquish its tools and subprocesses. */
export function execute(driver: Driver, options: Omit<Options, "signal">) {
  return Effect.callback<void, Error>((resume) => {
    const controller = new AbortController()
    const pending = driver.run({ ...options, signal: controller.signal })
    void pending.then(
      () => resume(Effect.void),
      (error: unknown) =>
        resume(
          Effect.fail(
            new Error({
              message:
                typeof error === "object" && error !== null && "message" in error
                  ? String(error.message)
                  : String(error),
            }),
          ),
        ),
    )
    return Effect.promise(async () => {
      controller.abort()
      await pending.catch(() => undefined)
    })
  })
}
