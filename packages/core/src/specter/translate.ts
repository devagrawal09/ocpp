export * as SpecterTranslate from "./translate.js"

import { Event } from "@ocpp/schema/event"
import { SessionEvent } from "@ocpp/schema/session-event"
import { toOcppEventType, type PersistedEvent } from "@specter/agent-runtime"

/** One OC++ wire event a Specter fact projects as. */
export interface WireEvent {
  readonly definition: Event.DurableDefinition
  readonly data: unknown
  readonly id: Event.ID
}

const durable = new Map<string, Event.DurableDefinition>(
  SessionEvent.DurableDefinitions.map((definition) => [definition.type, definition]),
)

/**
 * The OC++ events a fact in Specter's log projects as. The runtime's consolidated catalog merges some
 * of OC++'s events, so one fact can project as several; facts OC++ shares keep their name and shape.
 * This is the only place the two vocabularies meet, and it goes when OC++'s protocol adopts the
 * consolidated catalog.
 */
export const toWire = (event: PersistedEvent): readonly WireEvent[] => {
  const id = Event.ID.make(event.id)
  if (event.type === "session-execution-settled") {
    const payload = event.payload as {
      readonly sessionID: string
      readonly outcome: "succeeded" | "failed" | "interrupted"
      readonly error?: unknown
      readonly reason?: string
    }
    const { sessionID } = payload
    if (payload.outcome === "succeeded")
      return [{ definition: SessionEvent.Execution.Succeeded, data: { sessionID }, id }]
    if (payload.outcome === "failed")
      return [{ definition: SessionEvent.Execution.Failed, data: { sessionID, error: payload.error }, id }]
    return [{ definition: SessionEvent.Execution.Interrupted, data: { sessionID, reason: payload.reason }, id }]
  }
  const definition = durable.get(toOcppEventType(event.type))
  if (!definition) throw new Error(`Specter recorded ${event.type}, which OC++ cannot project`)
  return [{ definition, data: event.payload, id }]
}
