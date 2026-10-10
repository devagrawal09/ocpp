import { createEventDefinition, type EventDefinition } from "@specter-ts/core"
import { DurableEventManifest } from "@ocpp/schema/durable-event-manifest"
import { Schema } from "effect"

// Every durable fact OC++ records, from its manifest of durable events: its
// Session events (the runtime's own Session Execution facts among them), the
// facts an external agent's Session keeps, and the facts of its other
// aggregates. Each is defined once, in @ocpp/schema, under the name the log
// stores. A fact whose shape changes gets a new name, so one name never carries
// two shapes in the log.
const definitions = DurableEventManifest.Definitions

// One Specter event definition per durable fact: its name, and its payload
// schema as a Standard Schema.
export const sessionEventDefinitions = definitions.map((definition) =>
  createEventDefinition(definition.type, Schema.toStandardSchemaV1(definition.data)),
)

type Definitions = (typeof definitions)[number]

export type SessionEventPayloads = {
  [D in Definitions as D["type"]]: Schema.Schema.Type<D["data"]>
}

export const sessionEvent = <K extends keyof SessionEventPayloads>(
  type: K,
): EventDefinition<K, SessionEventPayloads[K]> => {
  const definition = sessionEventDefinitions.find((candidate) => candidate.type === type)
  if (!definition) throw new Error(`Unknown session event: ${type}`)
  // Single cast (via unknown: create() is contravariant in the payload, so TS
  // sees no overlap between the wide and the narrowed definition). The runtime
  // array is built from the same definitions SessionEventPayloads is derived
  // from at the type level, so K and the payload type always correspond.
  return definition as unknown as EventDefinition<K, SessionEventPayloads[K]>
}
