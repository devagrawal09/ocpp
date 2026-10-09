export * as SpecterSessionRuntime from "./session-runtime.js"

import { Context, Effect, Layer, PubSub, Stream, SubscriptionRef } from "effect"
import { eq } from "drizzle-orm"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { Event } from "@ocpp/schema/event"
import {
  DeltaChannel,
  makeEmbeddedSessionRuntime,
  Model,
  SpecterCommandRejectedError,
  toOcppEventType,
  type Delta,
  type EmbeddedSessionRuntime,
} from "@specter/agent-runtime"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { SessionEvent } from "../session/event.js"
import { SessionMessage } from "../session/message.js"
import { SessionSchema } from "../session/schema.js"
import { SessionTable } from "../session/sql.js"
import { SessionStore } from "../session/store.js"
import { SpecterSessionModel } from "./session-model.js"

/**
 * The embedded Specter runtime that runs whole Sessions (M4 increment 1). It owns every Session
 * Execution fact it records: inbox, execution, steps, text and tools. OC++ keeps its own event stream
 * and projections in step by receiving each commit on the Bus, in log order and under the same event
 * IDs, before the Command that recorded it returns. OC++ still owns everything else about a Session,
 * starting with its creation.
 */
export interface Interface {
  readonly runtime: EmbeddedSessionRuntime
  /** Records an OC++ Session with the runtime, once, before its first runtime Command. */
  readonly register: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Sessions with an execution the runtime has started and not yet ended. */
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

const durable = new Map<string, Event.DurableDefinition>(
  SessionEvent.DurableDefinitions.map((definition) => [definition.type, definition]),
)

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const store = yield* SessionStore.Service
    const db = (yield* Database.Service).db
    const model = yield* SpecterSessionModel.Service
    const active = yield* SubscriptionRef.make<ReadonlySet<SessionSchema.ID>>(new Set())
    const deltas = yield* PubSub.unbounded<Delta>()
    // Message IDs must outlive the runtime's in-memory log, so each boot gets its own prefix.
    const boot = SessionMessage.ID.create()

    const track = (type: string, sessionID: SessionSchema.ID) => {
      if (type === "session-execution-started")
        return SubscriptionRef.update(active, (current) => new Set(current).add(sessionID))
      if (
        type === "session-execution-succeeded" ||
        type === "session-execution-failed" ||
        type === "session-execution-interrupted"
      )
        return SubscriptionRef.update(active, (current) => {
          const next = new Set(current)
          next.delete(sessionID)
          return next
        })
      return Effect.void
    }

    const runtime = yield* makeEmbeddedSessionRuntime({
      eventId: () => Event.ID.create(),
      // OC++ owns session.created; the runtime records it only to know the Session exists.
      onCommit: (events) =>
        Effect.gen(function* () {
          const forwarded = events
            .filter((event) => event.type !== "session-created")
            .map((event) => {
              const definition = durable.get(toOcppEventType(event.type))
              if (!definition) throw new Error(`The runtime recorded an event OC++ does not define: ${event.type}`)
              return [definition, event.payload, { id: Event.ID.make(event.id) }] as unknown as Bus.PublishInput
            })
          const [first, ...rest] = forwarded
          if (first) yield* bus.publishAll([first, ...rest])
          yield* Effect.forEach(
            events,
            (event) => track(event.type, (event.payload as { sessionID: SessionSchema.ID }).sessionID),
            { discard: true },
          )
        }).pipe(Effect.orDie),
      step: {
        assistantMessageID: ({ sessionID, ordinal }) => `${boot}_${sessionID}_${ordinal}`,
        agent: (sessionID) =>
          store.get(SessionSchema.ID.make(sessionID)).pipe(Effect.map((session) => session?.agent ?? "build")),
      },
    }).pipe(
      Effect.provide(
        Layer.mergeAll(Layer.succeed(Model, model), Layer.succeed(DeltaChannel, DeltaChannel.of({ pubsub: deltas }))),
      ),
      Effect.orDie,
    )

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
        .command({
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
        })
        .pipe(
          // A Session registers once; a concurrent registration is the same fact.
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
      awaitIdle: (sessionID) =>
        SubscriptionRef.changes(active).pipe(
          Stream.filter((current) => !current.has(sessionID)),
          Stream.take(1),
          Stream.runDrain,
        ),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Bus.node, Database.node, SessionStore.node, SpecterSessionModel.node],
})
