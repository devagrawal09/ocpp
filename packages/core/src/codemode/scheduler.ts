export * as CodeModeScheduler from "./scheduler.js"

import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { Clock, Context, Effect, FiberMap, Layer, PubSub } from "effect"
import { LocationServiceMap } from "../location-service-map.js"
import { PluginSupervisor } from "../plugin/supervisor-service.js"
import { SessionStore } from "../session/store.js"
import { CodeModeEvent } from "./event.js"
import { CodeModeInvocation } from "./invocation-service.js"

/**
 * Fires enabled events on their schedules in this process, like other local execution. It starts at
 * boot from the stored definitions and follows later definition changes. Firings missed while the host
 * was down are not replayed; each event resumes at its next scheduled time, except that a one-time
 * event whose time passed fires once. Events of archived Sessions do not fire.
 */
export class Service extends Context.Service<Service, {}>()("@ocpp/CodeModeScheduler") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* CodeModeEvent.Service
    const sessions = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const fibers = yield* FiberMap.make<string>()
    const changes = yield* events.changes

    const fire = Effect.fnUntraced(function* (key: CodeModeEvent.Key) {
      const session = yield* sessions.get(key.sessionID)
      if (!session || session.time.archived) return
      yield* Effect.gen(function* () {
        const plugins = yield* PluginSupervisor.Service
        yield* plugins.flush
        const invocations = yield* CodeModeInvocation.Service
        // A firing that cannot start records its own error.
        yield* invocations.fire(key).pipe(Effect.ignore)
      }).pipe(Effect.provide(locations.get(session.location)))
    })

    // Firing only admits the run, so a slow handler never delays the schedule; an overlapping firing
    // is skipped and recorded by the invocation service.
    const loop = Effect.fnUntraced(function* (key: CodeModeEvent.Key) {
      while (true) {
        const event = yield* events.get(key)
        if (!event?.enabled) return
        // An archived Session stays archived, so its events stop instead of firing into it.
        if ((yield* sessions.get(key.sessionID))?.time.archived) return yield* events.scheduled(key, undefined)
        const now = yield* Clock.currentTimeMillis
        const time = CodeModeEvent.next(event.schedule, {
          now,
          anchor: event.time_created,
          fired: event.time_fired ?? undefined,
        })
        yield* events.scheduled(key, time)
        if (time === undefined) return
        yield* Effect.sleep(Math.max(0, time - now))
        // Recording the failure as a firing keeps a one-time event from retrying in a tight loop.
        yield* fire(key).pipe(
          Effect.catchDefect((defect) =>
            Effect.gen(function* () {
              yield* Effect.logError("event firing failed", { ...key, defect })
              yield* events.fired(key, { at: yield* Clock.currentTimeMillis, error: "The firing failed unexpectedly." })
            }),
          ),
        )
      }
    })

    const schedule = (key: CodeModeEvent.Key) => FiberMap.run(fibers, key.sessionID + "/" + key.name, loop(key))

    yield* Effect.forEach(
      yield* events.enabled(),
      (event) => schedule({ sessionID: event.session_id, name: event.name }),
      { discard: true },
    )
    yield* PubSub.take(changes).pipe(Effect.flatMap(schedule), Effect.forever, Effect.forkScoped)
    return Service.of({})
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [CodeModeEvent.node, SessionStore.node, LocationServiceMap.node],
})
