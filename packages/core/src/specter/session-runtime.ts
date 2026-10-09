export * as SpecterSessionRuntime from "./session-runtime.js"

import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect"
import { eq } from "drizzle-orm"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import {
  EventLog,
  makeEmbeddedSessionRuntime,
  SpecterCommandRejectedError,
  StepHost,
  type EmbeddedSessionRuntime,
  type EventLogService,
  type PersistedEvent,
} from "@specter/agent-runtime"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { LocationServiceMap } from "../location-service-map.js"
import { SessionSchema } from "../session/schema.js"
import { SessionTable } from "../session/sql.js"
import { SessionStore } from "../session/store.js"
import { SpecterStepHost } from "./step-host.js"

/**
 * The embedded Specter runtime that runs whole Sessions. It writes to the same Event Log as the Bus,
 * which projects every fact it records as OC++ events in the same transaction, so OC++'s read models
 * and listeners stay in step without a forwarding hook. It learns about Sessions from the log too:
 * session.created is a fact the Bus records there.
 */
export interface Interface {
  readonly runtime: EmbeddedSessionRuntime
  /** Records a Session the log predates with the runtime, once, before its first runtime Command. */
  readonly register: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Sessions with an execution the runtime has started and not yet settled. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Resolves once the runtime has no active execution for the Session. */
  readonly awaitIdle: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/SpecterSessionRuntime") {}

/** The rejection reason of a runtime Command, or undefined for any other failure. */
export const rejection = (error: unknown) =>
  error instanceof SpecterCommandRejectedError
    ? error.cause instanceof Error
      ? error.cause.message
      : String(error.cause)
    : undefined

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const db = (yield* Database.Service).db
    const active = yield* SubscriptionRef.make<ReadonlySet<SessionSchema.ID>>(new Set())
    const shared = yield* bus.specterLog

    const track = (events: readonly PersistedEvent[]) =>
      SubscriptionRef.update(active, (current) => {
        let next = current
        for (const event of events) {
          const sessionID = (event.payload as { readonly sessionID: SessionSchema.ID }).sessionID
          if (event.type === "session-execution-started") next = new Set(next).add(sessionID)
          if (event.type === "session-execution-settled" && next.has(sessionID)) {
            const settled = new Set(next)
            settled.delete(sessionID)
            next = settled
          }
        }
        return next
      })
    // The runtime's own commits are the only ones that start or settle an execution. Tracking them as
    // the append returns keeps `active` current before the Command that recorded them returns.
    const log: EventLogService = {
      ...shared,
      append: (drafts, options) =>
        shared
          .append(drafts, options)
          .pipe(Effect.tap((result) => (result.duplicate ? Effect.void : track(result.events)))),
    }

    // Resolves once the runtime has no active execution for the Session, from the runtime's own state.
    let started: EmbeddedSessionRuntime | undefined
    const awaitIdle = (sessionID: SessionSchema.ID) =>
      Effect.suspend(() =>
        started
          ? started.subscribe({ type: "executionStatus", payload: { sessionID } }).pipe(
              Stream.filter((status) => status.status !== "active"),
              Stream.take(1),
              Stream.runDrain,
              Effect.orDie,
            )
          : Effect.void,
      )

    // An attempt stops as soon as its execution settles: an interrupt cancels the model stream and the
    // tools it started, as it does in OC++'s own runner.
    const host = yield* SpecterStepHost.make
    const interruptible = StepHost.of({
      begin: (input) =>
        host.begin(input).pipe(
          Effect.map((plan) => ({
            ...plan,
            run: (record) =>
              Effect.raceFirst(
                plan.run(record),
                awaitIdle(SessionSchema.ID.make(input.sessionID)).pipe(Effect.as({ outcome: "stopped" as const })),
              ),
          })),
        ),
    })

    const runtime = yield* makeEmbeddedSessionRuntime().pipe(
      Effect.provide(Layer.mergeAll(Layer.succeed(EventLog, log), Layer.succeed(StepHost, interruptible))),
      Effect.orDie,
    )
    started = runtime

    const register = Effect.fn("SpecterSessionRuntime.register")(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      const row = yield* db
        .select({ slug: SessionTable.slug, version: SessionTable.version })
        .from(SessionTable)
        .where(eq(SessionTable.id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!session || !row) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
      yield* runtime
        .command(
          {
            type: "registerSession",
            payload: {
              sessionID,
              projectID: session.projectID,
              location: {
                directory: session.location.directory,
                ...(session.location.workspaceID === undefined ? {} : { workspaceID: session.location.workspaceID }),
              },
              slug: row.slug,
              version: row.version,
              ...(session.subpath === undefined ? {} : { subpath: session.subpath }),
              ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
              ...(session.title === undefined ? {} : { title: session.title }),
              ...(session.agent === undefined ? {} : { agent: session.agent }),
              ...(session.model === undefined ? {} : { model: session.model }),
              ...(session.metadata === undefined ? {} : { metadata: session.metadata }),
            },
          },
          // The Bus does not project this commit: OC++ recorded the Session's creation long ago.
          { idempotencyKey: `${Bus.registrationKeyPrefix}${sessionID}` },
        )
        .pipe(
          // A Session created since the log exists is already known from its session.created fact.
          Effect.catchIf(
            (error) => rejection(error) === "Session already registered",
            () => Effect.void,
          ),
          Effect.orDie,
        )
    })
    const registered = new Set<SessionSchema.ID>()

    return Service.of({
      runtime,
      register: (sessionID) =>
        registered.has(sessionID)
          ? Effect.void
          : register(sessionID).pipe(Effect.tap(() => Effect.sync(() => registered.add(sessionID)))),
      active: SubscriptionRef.get(active),
      awaitIdle,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Bus.node, Database.node, SessionStore.node, LocationServiceMap.node],
})
