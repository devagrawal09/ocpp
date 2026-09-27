export * as ExternalAgentDriver from "./driver.js"

import { Effect, Schema } from "effect"
import type { ExternalSession } from "@ocpp/schema/external-session"
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

/**
 * `ocpp`: the gateway's `execute` is the vendor's only capability, under the OC++ `system` prompt, with no vendor
 * settings, skills, or MCP servers of the user's. `native`: the vendor's own tools, prompt, and settings, with OC++
 * authorizing each native call; the gateway's tools are added over MCP.
 */
export type Harness = { readonly type: "ocpp"; readonly system: string } | { readonly type: "native" }

export interface Options {
  readonly directory: string
  readonly model: string
  readonly effort?: string
  /** Resumes this vendor session; absent, a new one starts from `history`. */
  readonly vendorSessionID?: string
  readonly history: ReadonlyArray<History>
  readonly message: string
  readonly harness: Harness
  readonly gateway: ExternalAgentGateway.Gateway
  readonly signal: AbortSignal
  /** Authorizes one of the vendor's native tool calls. Drivers never ask it about the gateway's own tools. */
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
  /**
   * The next input for this vendor session. While a turn runs it resolves only with steers; after `idle` it
   * resolves with any pending input, or undefined to end the run. Turn-end drivers call it only after `idle`.
   */
  readonly next: (signal: AbortSignal) => Promise<string | undefined>
  /** The vendor finished answering its input. */
  readonly idle: () => void
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

/** The first vendor message: canonical history when a new vendor session replaces a missing one, then the input. */
export function first(options: Pick<Options, "vendorSessionID" | "history" | "message">) {
  return [
    options.vendorSessionID === undefined && options.history.length > 0
      ? "Restored canonical OC++ history:\n" + replay(options.history)
      : "",
    options.message,
  ]
    .filter(Boolean)
    .join("\n\n")
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
