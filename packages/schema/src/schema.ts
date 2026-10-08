import { DateTime, Option, Schema, SchemaGetter } from "effect"

export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
export const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

// Effect 4 keeps `Schema.brand` only in TypeScript types. The `brands` annotation records the brand in the AST so
// client codegen can restore nominal types such as `Session.ID` instead of erasing them to their base type.
export const brand =
  <const B extends string>(identifier: Parameters<typeof Schema.brand<B>>[0]) =>
  <S extends Schema.ConstraintRebuildable>(schema: S) =>
    Schema.brand<B>(identifier)(schema).annotate({ brands: [identifier] })

export const RelativePath = Schema.String.pipe(brand("RelativePath"))
export type RelativePath = typeof RelativePath.Type

export const AbsolutePath = Schema.String.pipe(brand("AbsolutePath"))
export type AbsolutePath = typeof AbsolutePath.Type

export const optional = <S extends Schema.Top>(schema: S) =>
  Schema.optionalKey(schema).pipe(
    Schema.decodeTo(Schema.optional(Schema.toType(schema)), {
      decode: SchemaGetter.passthrough({ strict: false }),
      encode: SchemaGetter.transformOptional(Option.filter((value) => value !== undefined)),
    }),
  )

export const statics =
  <S extends object, M extends Record<string, unknown>>(methods: (schema: S) => M) =>
  (schema: S): S & M =>
    // Schema members such as `make` are prototype getters without setters, so assignment cannot shadow them.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- defineProperties adds every method in M.
    Object.defineProperties(schema, Object.getOwnPropertyDescriptors(methods(schema))) as S & M

export const DateTimeUtcFromMillis = Schema.Finite.pipe(
  Schema.decodeTo(Schema.DateTimeUtc, {
    decode: SchemaGetter.transform((value) => DateTime.makeUnsafe(value)),
    encode: SchemaGetter.transform((value) => DateTime.toEpochMillis(value)),
  }),
)
