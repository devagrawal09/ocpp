export * as ExternalAgentSession from "./session.js"

import { AbsolutePath } from "@ocpp/schema/schema"
import { ExternalSession } from "@ocpp/schema/external-session"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { eq } from "drizzle-orm"
import { Context, Deferred, Effect, Layer, Scope } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { StepFailedError } from "../session/error.js"
import { SessionEvent } from "../session/event.js"
import { ExternalSessionTable } from "./sql.js"

export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const database = yield* Database.Service
    const bus = yield* Bus.Service
    const db = database.db
    const reserved = new Set<ExternalSession.Info["sessionID"]>()
    const activations = new Map<
      ExternalSession.Info["sessionID"],
      { run: Effect.Effect<void, StepFailedError>; started: boolean; done: Deferred.Deferred<void> }
    >()
    yield* bus.project(ExternalSession.Bound, (event) =>
      db
        .insert(ExternalSessionTable)
        .values({
          session_id: event.data.sessionID,
          provider: event.data.provider,
          directory: event.data.directory,
          status: "idle",
        })
        .run()
        .pipe(Effect.orDie),
    )
    yield* bus.project(ExternalSession.Linked, (event) =>
      db
        .update(ExternalSessionTable)
        .set({
          vendor_session_id: event.data.vendorSessionID,
          checkpoint: null,
          history_hash: null,
        })
        .where(eq(ExternalSessionTable.session_id, event.data.sessionID))
        .run()
        .pipe(Effect.orDie),
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
                  },
            ),
          ),
      reserve: (sessionID) =>
        Effect.acquireRelease(
          Effect.suspend(() => {
            if (reserved.has(sessionID))
              return Effect.fail(
                new StepFailedError({
                  error: { type: "external.busy", message: "External session already has an active call" },
                }),
              )
            reserved.add(sessionID)
            return Effect.void
          }),
          () =>
            Effect.sync(() => {
              reserved.delete(sessionID)
            }),
        ),
      activate: (sessionID, run) =>
        Effect.acquireRelease(
          Effect.suspend(() => {
            if (activations.has(sessionID))
              return Effect.fail(
                new StepFailedError({
                  error: { type: "external.busy", message: "External session already has an active call" },
                }),
              )
            activations.set(sessionID, { run, started: false, done: Deferred.makeUnsafe<void>() })
            return Effect.void
          }),
          () =>
            Effect.gen(function* () {
              const activation = activations.get(sessionID)
              if (activation?.started) yield* Deferred.await(activation.done)
              activations.delete(sessionID)
            }),
        ),
      drain: (sessionID) =>
        Effect.suspend(() => {
          const activation = activations.get(sessionID)
          if (activation !== undefined) {
            if (activation.started) return Effect.void
            activation.started = true
            return activation.run.pipe(Effect.ensuring(Deferred.succeed(activation.done, undefined)))
          }
          return Effect.fail(
            new StepFailedError({
              error: {
                type: "external.activation-unavailable",
                message:
                  "Continue this external session through its external-agent tool with fresh private input and tool handles.",
              },
            }),
          )
        }),
    })
  }),
)

export interface Interface {
  readonly get: (sessionID: ExternalSession.Info["sessionID"]) => Effect.Effect<ExternalSession.Info | undefined>
  readonly reserve: (sessionID: ExternalSession.Info["sessionID"]) => Effect.Effect<void, StepFailedError, Scope.Scope>
  readonly activate: (
    sessionID: ExternalSession.Info["sessionID"],
    run: Effect.Effect<void, StepFailedError>,
  ) => Effect.Effect<void, StepFailedError, Scope.Scope>
  readonly drain: (sessionID: ExternalSession.Info["sessionID"]) => Effect.Effect<void, StepFailedError>
}
export class Service extends Context.Service<Service, Interface>()("@ocpp/ExternalAgentSession") {}
export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node] })
