export * as SessionExecution from "./execution.js"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import type { SessionRunner } from "./runner/index.js"
import type { SessionSchema } from "./schema.js"

export interface Interface {
  /** The Sessions with an active execution. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Whether the Session has an active execution. */
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

/**
 * Runs Sessions: wakes them for recorded work, resumes, interrupts and awaits their executions. The embedded
 * Specter runtime is the only implementation (`SpecterSessionExecution`).
 */
export class Service extends Context.Service<Service, Interface>()("@ocpp/SessionExecution") {}

/**
 * Bound to the runtime's (`SpecterSessionExecution.node`) by AppNodeBuilder. It is a node of its own so
 * that the modules depending on it stay out of the runtime's import graph.
 */
export const node = makeGlobalNode({
  service: Service,
  layer: Layer.effect(Service, Effect.die(new Error("Sessions run on the Specter runtime: build with AppNodeBuilder"))),
  deps: [],
})
