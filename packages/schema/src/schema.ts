import { DateTime, Option, Schema, SchemaGetter } from "effect"

export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const RelativePath = Schema.String.pipe(Schema.brand("RelativePath"))
export type RelativePath = typeof RelativePath.Type

export const AbsolutePath = Schema.String.pipe(Schema.brand("AbsolutePath"))
export type AbsolutePath = typeof AbsolutePath.Type

export const optional = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(schema).pipe(
    Schema.decodeTo(Schema.optional(Schema.toType(schema)), {
      decode: SchemaGetter.passthrough({ strict: false }),
      encode: SchemaGetter.transformOptional(Option.filter((value) => value !== undefined)),
    }),
  )

// Defines statics as own properties: effect 4.0.1 exposes schema members such as `make` as prototype
// getters without setters, which plain assignment (Object.assign) cannot shadow.
export const statics =
  <S extends object, M extends Record<string, unknown>>(methods: (schema: S) => M) =>
  (schema: S): S & M =>
    Object.defineProperties(schema, Object.getOwnPropertyDescriptors(methods(schema))) as S & M

export const DateTimeUtcFromMillis = Schema.Finite.pipe(
  Schema.decodeTo(Schema.DateTimeUtc, {
    decode: SchemaGetter.transform((value) => DateTime.makeUnsafe(value)),
    encode: SchemaGetter.transform((value) => DateTime.toEpochMillis(value)),
  }),
)

// Equivalent to Schema.isStartsWith, which effect 4.0.1 renamed to isStartingWith; isPattern exists in both.
export const isPrefixed = (prefix: string) =>
  Schema.isPattern(new RegExp("^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
