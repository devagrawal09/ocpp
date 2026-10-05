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

/** An image or PDF attached to delivered input, as base64. */
export interface Media {
  readonly type: "media"
  readonly mime: string
  readonly data: string
  readonly name?: string
}

/** Input delivered to the vendor, in message order. */
export type Input = ReadonlyArray<{ readonly type: "text"; readonly text: string } | Media>

/**
 * `ocpp`: the gateway's `execute` is the vendor's only capability, under the OC++ `system` prompt, with no vendor
 * settings, skills, or MCP servers of the user's. `native`: the vendor's own tools, prompt, settings and sandbox,
 * unrestricted by OC++; the gateway's tools are added over MCP.
 */
export type Harness = { readonly type: "ocpp"; readonly system: string } | { readonly type: "native" }

export interface Options {
  readonly directory: string
  readonly model: string
  readonly effort?: string
  /** Resumes this vendor session; absent, a new one starts from `history`. */
  readonly vendorSessionID?: string
  readonly history: ReadonlyArray<History>
  readonly message: Input
  readonly harness: Harness
  readonly gateway: ExternalAgentGateway.Gateway
  readonly signal: AbortSignal
  readonly emit: (event: Event) => Promise<void>
  readonly linked: (id: string) => Promise<void>
  readonly checkpointed: (checkpoint: string) => Promise<void>
  /**
   * The next input for this vendor session. While a turn runs it resolves only with steers; after `idle` it
   * resolves with any pending input, or undefined to end the run. Turn-end drivers call it only after `idle`.
   */
  readonly next: (signal: AbortSignal) => Promise<Input | undefined>
  /** The vendor finished answering its input. */
  readonly idle: () => void
}
export interface Driver {
  readonly provider: ExternalSession.Provider
  readonly inspect: (directory: string, id: string, signal: AbortSignal) => Promise<string | undefined>
  readonly run: (options: Options) => Promise<void>
}
export class Error extends Schema.TaggedError<Error>()("ExternalAgent.Error", { message: Schema.String }) {}
export class CompactionError extends Schema.TaggedError<CompactionError>()("ExternalAgent.CompactionError", {
  message: Schema.String,
}) {}

export function replay(history: ReadonlyArray<History>) {
  return history.map((item) => `${item.role}:\n${item.text}`).join("\n\n")
}

/** The first vendor message: canonical history when a new vendor session replaces a missing one, then the input. */
export function first(options: Pick<Options, "vendorSessionID" | "history" | "message">) {
  return join([
    options.vendorSessionID === undefined && options.history.length > 0
      ? [{ type: "text", text: "Restored canonical OC++ history:\n" + replay(options.history) }]
      : [],
    options.message,
  ])
}

/** Inputs as one, in order. Text that meets text is separated by a blank line, as separate messages always were. */
export function join(inputs: ReadonlyArray<Input>): Input {
  return inputs.flat().reduce<Input>((joined, part) => {
    const last = joined.at(-1)
    if (part.type !== "text" || last?.type !== "text") return [...joined, part]
    return [...joined.slice(0, -1), { type: "text", text: last.text + "\n\n" + part.text }]
  }, [])
}

/** Text in place of an attachment the vendor cannot take, naming the file and why. */
export function omitted(media: Media, reason: string) {
  return {
    type: "text" as const,
    text: `[Attached file ${media.name ?? "(unnamed)"} (${media.mime}) was not forwarded: ${reason}]`,
  }
}

/** Interruption waits for the SDK to relinquish its tools and subprocesses. */
export function execute(driver: Driver, options: Omit<Options, "signal">) {
  return Effect.callback<void, Error | CompactionError>((resume) => {
    const controller = new AbortController()
    const state = { compaction: undefined as CompactionError | undefined }
    const pending = driver.run({
      ...options,
      signal: controller.signal,
      emit: async (event) => {
        // Codex has no hard disable control, so its compaction remains a best-effort exception.
        if (driver.provider !== "codex" && event.type === "status" && event.status === "compacting") {
          state.compaction = new CompactionError({
            message: "Vendor compaction is disabled; OC++ owns session compaction",
          })
          controller.abort()
          throw state.compaction
        }
        await options.emit(event)
      },
    })
    void pending.then(
      () => resume(state.compaction ? Effect.fail(state.compaction) : Effect.void),
      (error: unknown) =>
        resume(
          Effect.fail(
            state.compaction
              ? state.compaction
              : new Error({
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
