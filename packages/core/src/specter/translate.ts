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
  // An execution the host ran itself is OC++'s own execution lifecycle.
  if (event.type === "session-external-execution-started")
    return [{ definition: SessionEvent.Execution.Started, data: event.payload, id }]
  if (event.type === "session-execution-settled" || event.type === "session-external-execution-settled") {
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
  if (event.type === "session-step-settled") {
    // Whether another step follows is the runtime's orchestration, not part of OC++'s events.
    const {
      outcome,
      retry,
      continues: _,
      ...data
    } = event.payload as {
      readonly outcome: "succeeded" | "failed"
      readonly retry?: { readonly attempt: number; readonly at: number; readonly fresh?: true }
      readonly continues?: true
      readonly sessionID: string
      readonly assistantMessageID: string
      readonly error?: unknown
    }
    if (outcome === "succeeded") return [{ definition: SessionEvent.Step.Ended, data, id }]
    const failed: WireEvent = { definition: SessionEvent.Step.Failed, data, id }
    if (!retry) return [failed]
    return [
      // A transparent retry runs the same step again: OC++ records only that it is scheduled. A fresh one
      // follows a step whose output stands, so that step failed.
      ...(retry.fresh ? [failed] : []),
      {
        definition: SessionEvent.RetryScheduled,
        data: {
          sessionID: data.sessionID,
          assistantMessageID: data.assistantMessageID,
          // OC++ numbers the attempt about to run; the runtime counts retries.
          attempt: retry.attempt + 1,
          at: retry.at,
          error: data.error,
        },
        // A second OC++ event from one fact: its ID derives from the fact's.
        id: Event.ID.make(`${event.id}_retry`),
      },
    ]
  }
  if (event.type === "session-block-recorded") {
    const { kind, ...ended } = event.payload as {
      readonly kind: "text" | "reasoning"
      readonly sessionID: string
      readonly assistantMessageID: string
      readonly ordinal: number
    }
    const block = kind === "text" ? SessionEvent.Text : SessionEvent.Reasoning
    return [
      {
        definition: block.Started,
        data: { sessionID: ended.sessionID, assistantMessageID: ended.assistantMessageID, ordinal: ended.ordinal },
        id: Event.ID.make(`${event.id}_start`),
      },
      { definition: block.Ended, data: ended, id },
    ]
  }
  if (event.type === "session-tool-requested") {
    const { name, ...called } = event.payload as {
      readonly sessionID: string
      readonly assistantMessageID: string
      readonly id: string
      readonly name: string
      readonly input: Record<string, unknown>
    }
    const call = { sessionID: called.sessionID, assistantMessageID: called.assistantMessageID, id: called.id }
    return [
      { definition: SessionEvent.Tool.Input.Started, data: { ...call, name }, id: Event.ID.make(`${event.id}_input`) },
      {
        definition: SessionEvent.Tool.Input.Ended,
        // The raw input text is not recorded: it is the input as JSON.
        data: { ...call, text: JSON.stringify(called.input) },
        id: Event.ID.make(`${event.id}_text`),
      },
      { definition: SessionEvent.Tool.Called, data: called, id },
    ]
  }
  // Whether an input wakes the Session, or an execution takes queued input, is the runtime's scheduling.
  if (event.type === "session-inbox-held" || event.type === "session-execution-continued") return []
  if (event.type === "session-tool-input-failed") {
    const { name, text, ...failed } = event.payload as {
      readonly sessionID: string
      readonly assistantMessageID: string
      readonly id: string
      readonly name: string
      readonly text?: string
    }
    const call = { sessionID: failed.sessionID, assistantMessageID: failed.assistantMessageID, id: failed.id }
    return [
      { definition: SessionEvent.Tool.Input.Started, data: { ...call, name }, id: Event.ID.make(`${event.id}_input`) },
      ...(text === undefined
        ? []
        : [
            {
              definition: SessionEvent.Tool.Input.Ended,
              data: { ...call, text },
              id: Event.ID.make(`${event.id}_text`),
            },
          ]),
      { definition: SessionEvent.Tool.Failed, data: failed, id },
    ]
  }
  if (event.type === "session-tool-settled") {
    const { outcome, ...data } = event.payload as { readonly outcome: "succeeded" | "failed" }
    return [{ definition: outcome === "succeeded" ? SessionEvent.Tool.Success : SessionEvent.Tool.Failed, data, id }]
  }
  const definition = durable.get(toOcppEventType(event.type))
  if (!definition) throw new Error(`Specter recorded ${event.type}, which OC++ cannot project`)
  return [{ definition, data: event.payload, id }]
}
