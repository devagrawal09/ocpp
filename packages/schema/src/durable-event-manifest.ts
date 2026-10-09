export * as DurableEventManifest from "./durable-event-manifest.js"

import { ExternalSession } from "./external-session.js"
import { Event } from "./event.js"
import { Worktree } from "./worktree.js"
import { SessionEvent } from "./session-event.js"

/** Every durable event OC++ records. Each is a fact in Specter's Event Log. */
export const Definitions = [
  ...SessionEvent.DurableDefinitions,
  ...ExternalSession.Definitions,
  Worktree.Event.Resolved,
] as const

export const Durable = Event.durableMap(Definitions)
