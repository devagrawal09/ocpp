export * as ExternalAgentSession from "./session.js"

import { AbsolutePath } from "@ocpp/schema/schema"
import { ExternalSession } from "@ocpp/schema/external-session"
import type { SessionDriver } from "@ocpp/schema/session-driver"
import type { Tool } from "@ocpp/schema/tool"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Scope } from "effect"
import { Bus } from "../bus.js"
import { CodeModeStore } from "../codemode/store.js"
import { Database } from "../database/database.js"
import { StepFailedError } from "../session/error.js"
import { SessionEvent } from "../session/event.js"
import { ExternalSessionTable } from "./sql.js"

/** A running subagent call that drives a vendor child: its harness and the tools it lends the child. */
export interface Activation {
  readonly harness: SessionDriver.Harness
  /** Tools the call lends the child (tool.define handles, submit_result) that the native harness also exposes over MCP. */
  readonly tools: ReadonlyArray<Tool.Info>
}

export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const bus = yield* Bus.Service
    const db = database.db
    const activations = new Map<ExternalSession.Info["sessionID"], Activation>()
    // Binding again (another vendor or directory) starts a new vendor session rebuilt from canonical history.
    yield* bus.project(ExternalSession.Bound, (event) =>
      db
        .insert(ExternalSessionTable)
        .values({
          session_id: event.data.sessionID,
          provider: event.data.provider,
          directory: event.data.directory,
          status: "idle",
          harness: activations.get(event.data.sessionID)?.harness ?? null,
        })
        .onConflictDoUpdate({
          target: ExternalSessionTable.session_id,
          set: {
            provider: event.data.provider,
            directory: event.data.directory,
            vendor_session_id: null,
            checkpoint: null,
            history_hash: null,
            notebook: null,
            ...harnessOf(activations.get(event.data.sessionID)),
          },
        })
        .run()
        .pipe(Effect.orDie),
    )
    // A newly linked vendor session was just started from canonical history; the notebook as it stands now
    // stays in its instructions for the vendor session's lifetime.
    yield* bus.project(ExternalSession.Linked, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(ExternalSessionTable)
          .set({
            vendor_session_id: event.data.vendorSessionID,
            checkpoint: null,
            history_hash: null,
            notebook: yield* CodeModeStore.savedNames(db, event.data.sessionID),
          })
          .where(eq(ExternalSessionTable.session_id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie)
      }),
    )
    yield* bus.project(ExternalSession.Checkpointed, (event) =>
      db
        .update(ExternalSessionTable)
        .set({
          checkpoint: event.data.checkpoint,
          history_hash: event.data.historyHash,
        })
        .where(eq(ExternalSessionTable.session_id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
    )
    for (const [definition, status] of [
      [SessionEvent.Execution.Started, "running"],
      [SessionEvent.Execution.Succeeded, "completed"],
      [SessionEvent.Execution.Failed, "failed"],
      [SessionEvent.Execution.Interrupted, "interrupted"],
    ] as const) {
      yield* bus.project(definition, (event) =>
        db
          .update(ExternalSessionTable)
          .set({ status })
          .where(eq(ExternalSessionTable.session_id, event.data.sessionID))
          .run()
          .pipe(Effect.orDie),
      )
    }
    return Context.make(Service, {
      get: (sessionID) =>
        db
          .select()
          .from(ExternalSessionTable)
          .where(eq(ExternalSessionTable.session_id, sessionID))
          .get()
          .pipe(
            Effect.orDie,
            Effect.map((row) =>
              row === undefined
                ? undefined
                : {
                    sessionID: row.session_id,
                    provider: row.provider,
                    directory: AbsolutePath.make(row.directory),
                    vendorSessionID: row.vendor_session_id ?? undefined,
                    checkpoint: row.checkpoint ?? undefined,
                    historyHash: row.history_hash ?? undefined,
                    status: row.status,
                    ...(row.notebook ? { notebook: row.notebook } : {}),
                    ...(row.harness ? { harness: row.harness } : {}),
                  },
            ),
          ),
      activate: (sessionID, activation) =>
        Effect.acquireRelease(
          Effect.suspend(() => {
            if (activations.has(sessionID))
              return Effect.fail(
                new StepFailedError({
                  error: { type: "external.busy", message: "This vendor session already has an active subagent call" },
                }),
              )
            activations.set(sessionID, activation)
            // A later call that continues this child without naming a harness keeps this one. A child not bound
            // yet records it when its first drain binds it, while this activation is still held.
            return db
              .update(ExternalSessionTable)
              .set({ harness: activation.harness })
              .where(eq(ExternalSessionTable.session_id, sessionID))
              .run()
              .pipe(Effect.orDie, Effect.asVoid)
          }),
          () =>
            Effect.sync(() => {
              activations.delete(sessionID)
            }),
        ),
      activation: (sessionID) => Effect.sync(() => activations.get(sessionID)),
    })
  }),
)

/** The persisted binding, plus the notebook checkpoint the linked vendor session was started with. */
export interface Stored extends ExternalSession.Info {
  readonly notebook?: ReadonlyArray<string>
  /** The harness the last subagent call ran this child with. Absent for a binding no subagent call has held. */
  readonly harness?: SessionDriver.Harness
}

/** The harness a rebinding keeps: the active call's, else whatever was stored. */
const harnessOf = (activation: Activation | undefined) =>
  activation === undefined ? {} : { harness: activation.harness }

export interface Interface {
  readonly get: (sessionID: ExternalSession.Info["sessionID"]) => Effect.Effect<Stored | undefined>
  /** Holds the subagent call's activation for a vendor child until the scope closes. */
  readonly activate: (
    sessionID: ExternalSession.Info["sessionID"],
    activation: Activation,
  ) => Effect.Effect<void, StepFailedError, Scope.Scope>
  readonly activation: (sessionID: ExternalSession.Info["sessionID"]) => Effect.Effect<Activation | undefined>
}
export class Service extends Context.Service<Service, Interface>()("@ocpp/ExternalAgentSession") {}
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node] })
