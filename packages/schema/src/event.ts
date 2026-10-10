export * as Event from "./event.js"

import { Schema } from "effect"
import { optional } from "./schema.js"
import { ascending } from "./identifier.js"
import { Location } from "./location.js"
import { brand, statics } from "./schema.js"

export const ID = Schema.String.check(Schema.isStartingWith("evt_")).pipe(
  brand("Event.ID"),
  statics((schema) => ({ create: () => schema.make("evt_" + ascending()) })),
)
export type ID = typeof ID.Type

/**
 * Position in one aggregate's durable log. Values originate from the durable
 * event envelope and synced markers;
 * `after` cursors accept only values that came from those sources.
 */
export const Seq = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(brand("Event.Seq"))
export type Seq = typeof Seq.Type

/**
 * Where a durable event sits: its aggregate and its sequence there. Event types carry no version: a fact
 * whose shape changes gets a new name, so one name never carries two shapes.
 */
const DurableEnvelope = Schema.Struct({ aggregateID: Schema.String, seq: Seq })
export type DurableEnvelope = typeof DurableEnvelope.Type

export type DurableDefinition<
  Type extends string = string,
  DataSchema extends Schema.Codec<unknown, unknown> = Schema.Codec<unknown, unknown>,
> = Schema.Top & {
  readonly type: Type
  readonly durability: "durable"
  readonly durable: {
    readonly aggregate: string
  }
  readonly data: DataSchema
}

export type EphemeralDefinition<
  Type extends string = string,
  DataSchema extends Schema.Codec<unknown, unknown> = Schema.Codec<unknown, unknown>,
> = Schema.Top & {
  readonly type: Type
  readonly durability: "ephemeral"
  readonly durable?: never
  readonly data: DataSchema
}

export type Definition<
  Type extends string = string,
  DataSchema extends Schema.Codec<unknown, unknown> = Schema.Codec<unknown, unknown>,
> = DurableDefinition<Type, DataSchema> | EphemeralDefinition<Type, DataSchema>

export type Data<D extends Definition> = Schema.Schema.Type<D["data"]>

type PayloadBase<D extends Definition> = {
  readonly id: ID
  readonly type: D["type"]
  readonly created: number
  readonly data: Data<D>
  readonly location?: Location.Ref
  readonly metadata?: Record<string, unknown>
}

export type Payload<D extends Definition = Definition> = D extends DurableDefinition
  ? PayloadBase<D> & { readonly durable: DurableEnvelope }
  : PayloadBase<D> & { readonly durable?: never }

type Fields = Readonly<Record<PropertyKey, Schema.Codec<unknown, unknown>>>

type Input<Type extends string, Fields> = {
  readonly type: Type
  readonly identifier?: string
  readonly durable?: {
    readonly aggregate: string
  }
  readonly schema: Fields
}

/** A payload's schema: a struct of the given fields, or the given schema itself (a union of outcomes). */
type DataOf<Data> = Data extends Schema.Top ? Data : Data extends Fields ? Schema.Struct<Data> : never

const dataOf = <Data extends Fields | Schema.Codec<unknown, unknown>>(schema: Data) =>
  (Schema.isSchema(schema) ? schema : Schema.Struct(schema as Fields)) as DataOf<Data>

export function durable<const Type extends string, const Data extends Fields | Schema.Codec<unknown, unknown>>(
  input: Input<Type, Data> & { readonly durable: NonNullable<Input<Type, Data>["durable"]> },
) {
  const data = dataOf(input.schema)
  return Schema.Struct({
    id: ID,
    created: Schema.Finite,
    metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
    type: Schema.Literal(input.type),
    durable: DurableEnvelope,
    location: optional(Location.Ref),
    data,
  })
    .annotate({ identifier: input.identifier ?? input.type })
    .pipe(
      statics(() => ({
        type: input.type,
        durability: "durable" as const,
        durable: input.durable,
        data,
      })),
    ) satisfies DurableDefinition<Type, typeof data>
}

export function ephemeral<const Type extends string, const Data extends Fields>(
  input: Omit<Input<Type, Data>, "durable">,
) {
  const data = Schema.Struct(input.schema)
  return Schema.Struct({
    id: ID,
    created: Schema.Finite,
    metadata: optional(Schema.Record(Schema.String, Schema.Unknown)),
    type: Schema.Literal(input.type),
    location: optional(Location.Ref),
    data,
  })
    .annotate({ identifier: input.identifier ?? input.type })
    .pipe(
      statics(() => ({
        type: input.type,
        durability: "ephemeral" as const,
        durable: undefined,
        data,
      })),
    ) satisfies EphemeralDefinition<Type, typeof data>
}

export function inventory<const Definitions extends ReadonlyArray<Definition>>(...definitions: Definitions) {
  return Object.freeze(definitions)
}

/** Definitions by type. One type names one definition: a fact whose shape changes gets a new name. */
export function byType(definitions: ReadonlyArray<Definition>) {
  return readonlyMap(
    definitions.reduce((result, definition) => {
      const existing = result.get(definition.type)
      if (existing !== undefined && existing !== definition)
        throw new Error(`Duplicate event definition for ${definition.type}`)
      return result.set(definition.type, definition)
    }, new Map<string, Definition>()),
  )
}

export function durableMap<const Definitions extends ReadonlyArray<Definition>>(definitions: Definitions) {
  return readonlyMap(
    definitions.reduce((result, definition) => {
      if (definition.durability !== "durable") return result
      if (result.has(definition.type)) throw new Error(`Duplicate durable event definition for ${definition.type}`)
      result.set(definition.type, definition)
      return result
    }, new Map<string, DurableDefinition>()),
  )
}

function readonlyMap<Key, Value>(map: Map<Key, Value>): ReadonlyMap<Key, Value> {
  const result: ReadonlyMap<Key, Value> = Object.freeze({
    get size() {
      return map.size
    },
    entries: () => map.entries(),
    forEach: (callback: (value: Value, key: Key, map: ReadonlyMap<Key, Value>) => void, thisArg?: unknown) =>
      map.forEach((value, key) => callback.call(thisArg, value, key, result)),
    get: (key: Key) => map.get(key),
    has: (key: Key) => map.has(key),
    keys: () => map.keys(),
    values: () => map.values(),
    [Symbol.iterator]: () => map[Symbol.iterator](),
  })
  return result
}
