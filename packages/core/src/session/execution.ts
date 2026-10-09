export * as SessionExecution from "./execution.js"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import type { SessionRunner } from "./runner/index.js"
import type { SessionSchema } from "./schema.js"

export interface Interface {
  /** Snapshots active execution owned by this process. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Checks process-local ownership, including interruption cleanup and terminal settlement. */
  readonly isActive: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Starts execution while idle or joins the active execution. */
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Registers newly recorded work. Repeated wakeups may coalesce. */
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /**
   * Interrupt active work owned by this process. Idle interruption is a no-op. Resolves once
   * the interruption is accepted; cleanup settles asynchronously in the execution fiber.
   * Returns whether an active execution was interrupted. Compose with `awaitIdle` when
   * settlement matters.
   */
  readonly interrupt: (sessionID: SessionSchema.ID, options?: { readonly continue?: boolean }) => Effect.Effect<boolean>
  /** Resolves once this process owns no active execution for the Session. Returns immediately when idle and never starts work. */
  readonly awaitIdle: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

/** Runs Sessions: wakes them for recorded work, resumes, interrupts and awaits their executions. */
export class Service extends Context.Service<Service, Interface>()("@ocpp/SessionExecution") {}

/**
 * Every Session runs on the embedded Specter runtime, which AppNodeBuilder supplies in place of this node
 * (`SpecterSessions.replacements`). A composition without the runtime supplies its own execution, such as
 * `noopLayer`.
 */
export const node = makeGlobalNode({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.die(new Error("SessionExecution runs on the Specter runtime: build the app with AppNodeBuilder")),
  ),
  deps: [],
})

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    active: Effect.succeed(new Set()),
    isActive: () => Effect.succeed(false),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
  }),
)
