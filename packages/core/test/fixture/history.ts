export * as TestHistory from "./history"

import { Effect, Schema } from "effect"
import { Bus } from "@ocpp/core/bus"
import type { Event } from "@ocpp/schema/event"

/**
 * The Bus for a test that sets up history: its runtime registers the test-only `recordHistory`, which records facts
 * as given and decides nothing. Production never makes the runtime with it.
 */
export const bus = [Bus.node, Bus.configured({ history: true })] as const

/**
 * Records facts the runtime's Commands would have recorded (inbox, execution and step facts), as a publication
 * through the Bus would: with the options at each position, in one commit, projected and notified. For history
 * a test needs before what it exercises, never for what the test is about.
 */
export const of = (bus: Bus.Interface) => {
  const publishAll = <const I extends readonly [Bus.PublishInput, ...Bus.PublishInput[]]>(facts: I) =>
    bus
      .command(
        {
          type: "recordHistory",
          payload: {
            facts: facts.map(([definition, data]) => ({
              type: definition.type,
              payload: Schema.encodeUnknownSync(definition.data)(data),
            })),
          },
        } as unknown as Bus.RuntimeCommand,
        { facts: facts.map(([, , options]) => options) },
      )
      .pipe(
        Effect.orDie,
        Effect.map((events) => events as unknown as Bus.PublishResult<I>),
      )
  const publish = <D extends Event.DurableDefinition>(
    definition: D,
    data: Event.Data<D>,
    options?: Bus.PublishOptions,
  ): Effect.Effect<Event.Payload<D>> =>
    publishAll([[definition, data, options]] as const).pipe(Effect.map((events) => events[0] as Event.Payload<D>))
  return { publish, publishAll }
}

/**
 * The Bus as code under test sees it when that code publishes a step's facts itself (OC++'s step attempt, which the
 * runtime's recorder takes them from in production): its durable facts are recorded as history, live events go out.
 */
export const recording = (bus: Bus.Interface): Bus.Interface => ({
  ...bus,
  publish: (definition, data, options) =>
    (definition.durable
      ? of(bus).publish(definition as Event.DurableDefinition, data as never, options)
      : bus.publish(definition, data, options)) as never,
})
