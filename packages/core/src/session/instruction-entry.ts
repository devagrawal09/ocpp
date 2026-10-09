export * as InstructionEntry from "./instruction-entry.js"

import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { InstructionEntry } from "@ocpp/schema/instruction-entry"
import { SessionFact } from "@ocpp/schema/session-fact"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { makeLocationNode } from "@ocpp/util/effect/app-node"
import { Instructions } from "../instructions/index.js"
import { SessionSchema } from "./schema.js"
import { SessionProjector } from "./projector.js"
import { InstructionEntryTable } from "./sql.js"

export const Key = InstructionEntry.Key
export type Key = typeof Key.Type
export const Info = InstructionEntry.Info
export type Info = typeof Info.Type
export const Snapshot = InstructionEntry.Snapshot
export type Snapshot = typeof Snapshot.Type
export const MaxValueBytes = InstructionEntry.MaxValueBytes
export const ValueTooLargeError = InstructionEntry.ValueTooLargeError

type DatabaseService = Database.Interface["db"]

export const snapshot = Effect.fn("InstructionEntry.snapshot")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  return yield* db
    .select({
      key: InstructionEntryTable.key,
      value: InstructionEntryTable.value,
      removed: InstructionEntryTable.removed,
    })
    .from(InstructionEntryTable)
    .where(eq(InstructionEntryTable.session_id, sessionID))
    .orderBy(asc(InstructionEntryTable.key))
    .all()
    .pipe(Effect.orDie)
})

export interface Interface {
  readonly list: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Info>>
  readonly put: (input: {
    readonly sessionID: SessionSchema.ID
    readonly key: Key
    readonly value: Schema.Json
  }) => Effect.Effect<void, InstructionEntry.ValueTooLargeError>
  readonly remove: (input: { readonly sessionID: SessionSchema.ID; readonly key: Key }) => Effect.Effect<void>
  /** Produces one Instructions source per stored entry, keyed `api/<key>`. */
  readonly load: (sessionID: SessionSchema.ID) => Effect.Effect<Instructions.List>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/InstructionEntry") {}

const renderValue = (value: Schema.Json) => (typeof value === "string" ? value : JSON.stringify(value, null, 2))

const renderBlock = (key: Key, value: Schema.Json) =>
  [`<context key="${key}">`, renderValue(value), "</context>"].join("\n")

// Rendering stays mechanism-neutral: the model sees session context, not how
// it was attached. Only chronological updates and removals carry narration.
const source = (entry: Info & { readonly removed: boolean }) =>
  Instructions.make<Schema.Json>({
    key: Instructions.Key.make(`api/${entry.key}`),
    codec: Schema.toCodecJson(Schema.Json),
    read: Effect.succeed(entry.removed ? Instructions.removed : entry.value),
    render: {
      initial: (value) => renderBlock(entry.key, value),
      changed: (_previous, value) =>
        [
          `The context under "${entry.key}" changed and supersedes the previous value:`,
          renderBlock(entry.key, value),
        ].join("\n"),
      removed: () => `The context under "${entry.key}" no longer applies. Disregard it.`,
    },
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const bus = yield* Bus.Service

    const rows = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, includeRemoved: boolean) {
      return yield* db
        .select({
          key: InstructionEntryTable.key,
          value: InstructionEntryTable.value,
          removed: InstructionEntryTable.removed,
        })
        .from(InstructionEntryTable)
        .where(
          and(
            eq(InstructionEntryTable.session_id, sessionID),
            includeRemoved ? undefined : eq(InstructionEntryTable.removed, false),
          ),
        )
        .orderBy(asc(InstructionEntryTable.key))
        .all()
        .pipe(Effect.orDie)
    })

    const list = Effect.fn("InstructionEntry.list")(function* (sessionID: SessionSchema.ID) {
      return (yield* rows(sessionID, false)).map((row) => ({ key: row.key, value: row.value }))
    })

    const put = Effect.fn("InstructionEntry.put")(function* (input: Parameters<Interface["put"]>[0]) {
      const actualBytes = Buffer.byteLength(JSON.stringify(input.value), "utf8")
      if (actualBytes > MaxValueBytes)
        yield* new ValueTooLargeError({
          actualBytes,
          maxBytes: MaxValueBytes,
          message: `Instruction entry value is ${actualBytes} bytes; the limit is ${MaxValueBytes} bytes`,
        })
      // The entry's row is the projection of its facts in Specter's Event Log.
      const stored = yield* db
        .select({ value: InstructionEntryTable.value, removed: InstructionEntryTable.removed })
        .from(InstructionEntryTable)
        .where(and(eq(InstructionEntryTable.session_id, input.sessionID), eq(InstructionEntryTable.key, input.key)))
        .get()
        .pipe(Effect.orDie)
      if (stored && !stored.removed && JSON.stringify(stored.value) === JSON.stringify(input.value)) return
      yield* bus.publish(SessionFact.InstructionEntrySet, input)
    })

    const remove = Effect.fn("InstructionEntry.remove")(function* (input: Parameters<Interface["remove"]>[0]) {
      const stored = yield* db
        .select({ removed: InstructionEntryTable.removed })
        .from(InstructionEntryTable)
        .where(and(eq(InstructionEntryTable.session_id, input.sessionID), eq(InstructionEntryTable.key, input.key)))
        .get()
        .pipe(Effect.orDie)
      if (!stored || stored.removed) return
      yield* bus.publish(SessionFact.InstructionEntryRemoved, input)
    })

    const load = Effect.fn("InstructionEntry.load")(function* (sessionID: SessionSchema.ID) {
      return Instructions.combine((yield* rows(sessionID, true)).map(source))
    })

    return Service.of({ list, put, remove, load })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, Bus.node, SessionProjector.node],
})
