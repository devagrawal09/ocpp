export * as CodeModeInvocation from "./invocation-service.js"

import type { CodeModeExecution } from "@ocpp/schema/codemode-execution"
import type { SessionMessage } from "@ocpp/schema/session-message"
import { Context, Effect, Schema } from "effect"
import type { SessionSchema } from "../session/schema.js"

/**
 * Dependency-only invocation seam. Keep this module free of implementation imports: invocations reach
 * the tool registry, which reaches PluginRuntime and through it Session.
 */
export class InvocationError extends Schema.TaggedError<InvocationError>()("CodeModeInvocation.Error", {
  message: Schema.String,
}) {}

export type Started = { readonly executionID: CodeModeExecution.ID; readonly messageID: SessionMessage.ID }

export interface Interface {
  /**
   * Runs `return handler(input)` as a Code Mode execution owned by a new invocation message, with the
   * Session agent's tools and permissions. It returns once the execution is admitted; the outcome
   * reaches the model later without waking it.
   */
  readonly run: (input: {
    readonly sessionID: SessionSchema.ID
    readonly trigger: SessionMessage.InvocationTrigger
    readonly handler: string
    readonly input: Schema.Json
  }) => Effect.Effect<Started, InvocationError>
  /** Runs the Session's command with the user's text, or returns undefined when it has no such command. */
  readonly command: (input: {
    readonly sessionID: SessionSchema.ID
    readonly name: string
    readonly text: string
  }) => Effect.Effect<Started | undefined, InvocationError>
  /** Fires an event now, or skips the firing while the previous one is still running. */
  readonly fire: (input: {
    readonly sessionID: SessionSchema.ID
    readonly name: string
    readonly input?: Schema.Json
  }) => Effect.Effect<({ readonly status: "started" } & Started) | { readonly status: "skipped" }, InvocationError>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/CodeModeInvocation") {}
