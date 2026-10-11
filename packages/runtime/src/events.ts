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

// The identities a fact can be about, each under the name of its kind. A fact
// declares a key for its aggregate and for every other identity its payload
// names (a fork's parent, a Session's project, an inbox item, a credential's
// integration, a Code Mode execution), so a Command that decides on one of
// them conflicts with it. Names keep ID spaces apart: a Command keyed by a
// Session never conflicts with a fact about a project of the same ID, and a
// Reaction keyed by Session runs only for the Sessions a commit records for.
const keyNames: Readonly<Record<string, string>> = {
  sessionID: "session",
  parentID: "parent",
  projectID: "project",
  workspaceID: "workspace",
  inboxID: "inbox",
  executionID: "execution",
  notificationID: "notification",
  credentialID: "credential",
  integrationID: "integration",
}

// A key-value fact's aggregate is its key, which no other fact's `key` field
// (an instruction entry's) names.
const aggregateKeyNames: Readonly<Record<string, string>> = { ...keyNames, key: "kv" }

// The fields a fact's payload can have: a struct's, or those of a union's members.
const fieldsOf = (schema: Schema.Top): ReadonlyArray<string> =>
  "fields" in schema && typeof schema.fields === "object" && schema.fields !== null
    ? Object.keys(schema.fields)
    : "members" in schema && Array.isArray(schema.members)
      ? [...new Set(schema.members.flatMap((member: Schema.Top) => fieldsOf(member)))]
      : []

const keysOf = (definition: (typeof definitions)[number]) => {
  const aggregate = definition.durable.aggregate
  const aggregateName = aggregateKeyNames[aggregate]
  if (aggregateName === undefined) throw new Error(`No key names the aggregate of ${definition.type}: ${aggregate}`)
  const fields = fieldsOf(definition.data).filter((field) => keyNames[field] !== undefined)
  return Object.fromEntries(
    [...new Set([aggregate, ...fields])].map((field) => [
      field === aggregate ? aggregateName : keyNames[field]!,
      (payload: unknown) => {
        const value = (payload as Record<string, unknown>)[field]
        return typeof value === "string" ? value : undefined
      },
    ]),
  )
}

// One Specter event definition per durable fact: its name, its payload
// schema as a Standard Schema, and its named keys.
export const sessionEventDefinitions = definitions.map((definition) =>
  createEventDefinition(definition.type, Schema.toStandardSchemaV1(definition.data), {
    keys: keysOf(definition),
  }),
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
