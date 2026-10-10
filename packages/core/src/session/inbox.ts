export * as SessionInbox from "./inbox.js"

import { and, asc, eq, or } from "drizzle-orm"
import { Context, DateTime, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import {
  Compaction,
  CompactionPayload,
  Delivery,
  Info,
  Item,
  Move,
  MovePayload,
  Synthetic,
  SyntheticPayload,
  User,
  UserPayload,
} from "@ocpp/schema/session-inbox"
import type { Database } from "../database/database.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionInboxTable, SessionMessageTable } from "./sql.js"

type DatabaseService = Database.Interface["db"]

export {
  Compaction,
  CompactionPayload,
  Delivery,
  Info,
  Item,
  Move,
  MovePayload,
  Synthetic,
  SyntheticPayload,
  User,
  UserPayload,
}

/**
 * Which pending input a boundary takes: "steer" takes steers only (a step boundary mid-work, or a turn
 * that continues after an interrupt), while "input" also allows one queued input when no steers are
 * waiting (the idle boundary, where the Session picks up fresh work).
 */
export type Promotable = "input" | "steer"

const decodeUser = Schema.decodeUnknownSync(UserPayload)
const encodeUser = Schema.encodeSync(UserPayload)
const decodeSynthetic = Schema.decodeUnknownSync(SyntheticPayload)
const encodeSynthetic = Schema.encodeSync(SyntheticPayload)
const decodeCompaction = Schema.decodeUnknownSync(CompactionPayload)
const encodeCompaction = Schema.encodeSync(CompactionPayload)
const decodeMove = Schema.decodeUnknownSync(MovePayload)
const encodeMove = Schema.encodeSync(MovePayload)
const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Info)
type PendingRef = { readonly id: SessionMessage.ID; readonly sessionID: SessionSchema.ID }

export class LifecycleConflict extends Schema.TaggedError<LifecycleConflict>()("SessionInbox.LifecycleConflict", {
  id: SessionMessage.ID,
}) {}

const fromRow = (row: typeof SessionInboxTable.$inferSelect): Info => {
  const base = {
    id: SessionMessage.ID.make(row.id),
    sessionID: SessionSchema.ID.make(row.session_id),
    timeCreated: DateTime.makeUnsafe(row.time_created),
  }
  if (row.type === "compaction")
    return Compaction.make({
      ...base,
      type: "compaction",
      payload: decodeCompaction(row.payload),
      delivery: row.delivery,
    })
  if (row.type === "move")
    return Move.make({ ...base, type: "move", payload: decodeMove(row.payload), delivery: row.delivery })
  if (row.type === "user")
    return User.make({
      ...base,
      type: "user",
      payload: decodeUser(row.payload),
      delivery: row.delivery,
    })
  if (row.type === "synthetic")
    return Synthetic.make({
      ...base,
      type: "synthetic",
      payload: decodeSynthetic(row.payload),
      delivery: row.delivery,
    })
  throw new LifecycleConflict({ id: base.id })
}

export const find = Effect.fn("SessionInbox.find")(function* (db: DatabaseService, id: SessionMessage.ID) {
  const row = yield* db.select().from(SessionInboxTable).where(eq(SessionInboxTable.id, id)).get().pipe(Effect.orDie)
  return row === undefined ? undefined : fromRow(row)
})

/**
 * An item that was delivered, rebuilt from its projected message (the inbox keeps only pending items). The
 * message does not keep the item's delivery, so the caller supplies it.
 */
export const delivered = Effect.fn("SessionInbox.delivered")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  id: SessionMessage.ID,
  delivery: Delivery,
) {
  const row = yield* db
    .select()
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, id))
    .get()
    .pipe(Effect.orDie)
  if (row === undefined) return undefined
  if (row.session_id !== sessionID || (row.type !== "user" && row.type !== "synthetic"))
    return yield* new LifecycleConflict({ id })
  const message = decodeMessage({ ...row.data, id: row.id, type: row.type })
  const base = { id, sessionID, timeCreated: message.time.created, delivery }
  if (message.type === "user")
    return User.make({
      ...base,
      type: "user",
      payload: decodeUser(message),
    })
  if (message.type === "synthetic")
    return Synthetic.make({
      ...base,
      type: "synthetic",
      payload: decodeSynthetic(message),
    })
  return yield* new LifecycleConflict({ id })
})

type Admitted<Type extends Item["type"]> = Extract<Info, { readonly type: Type }>

/**
 * A Session's inbox. The embedded Specter runtime is the only one (`SpecterSessionInbox`): it decides
 * admission, cancellation and delivery changes, and its facts project as the `session_inbox` rows this
 * module reads.
 */
export interface Interface {
  /** Pending items, in admission order. */
  readonly list: (sessionID: SessionSchema.ID) => Effect.Effect<Info[]>
  /**
   * The item first admitted under an ID, pending or delivered, or undefined. An ID that names another
   * Session's item, an item of another type, or a compaction is a conflict. A read: admission is the
   * runtime's decision.
   */
  readonly admitted: <Type extends Item["type"]>(request: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly type: Type
    /** The delivery a delivered item reports, which its message does not keep. */
    readonly delivery: Delivery
  }) => Effect.Effect<Admitted<Type> | undefined, LifecycleConflict>
  /** Admits an item. Retrying an admitted ID returns the first admission and ignores the retried item. */
  readonly admit: <Type extends Item["type"]>(request: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly item: Item & { readonly type: Type }
    /**
     * Synthetic input that replaces the pending items admitted under the same key: `replaces` names
     * exactly those, whose payloads the caller merged into this one. They are cancelled in the
     * admission's own commit. When they changed meanwhile the admission is a conflict, and the
     * caller reads the inbox again.
     */
    readonly coalesce?: { readonly key: string; readonly replaces: ReadonlyArray<SessionMessage.ID> }
    /** false: the input waits for the next wake instead of waking the Session. */
    readonly resume?: boolean
  }) => Effect.Effect<Admitted<Type>, LifecycleConflict>
  /** Admits a manual compaction; a pending one absorbs the request. */
  readonly admitCompaction: (input: {
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly delivery: Delivery
  }) => Effect.Effect<Compaction, LifecycleConflict>
  readonly cancel: (input: PendingRef) => Effect.Effect<void, LifecycleConflict>
  readonly steer: (input: PendingRef) => Effect.Effect<void, LifecycleConflict>
  readonly queue: (input: PendingRef) => Effect.Effect<void, LifecycleConflict>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/SessionInbox") {}

/**
 * Bound to the runtime's (`SpecterSessionInbox.node`) by AppNodeBuilder. It is a node of its own so that
 * the modules depending on it stay out of the runtime's import graph.
 */
export const node = makeGlobalNode({
  service: Service,
  layer: Layer.effect(Service, Effect.die(new Error("Sessions run on the Specter runtime: build with AppNodeBuilder"))),
  deps: [],
})

export const projectAdmitted = Effect.fn("SessionInbox.projectAdmitted")(function* (
  db: DatabaseService,
  request: {
    readonly enqueuedSeq: number
    readonly id: SessionMessage.ID
    readonly sessionID: SessionSchema.ID
    readonly item: Item
    readonly timeCreated: number
  },
) {
  const message = yield* db
    .select({ id: SessionMessageTable.id })
    .from(SessionMessageTable)
    .where(eq(SessionMessageTable.id, request.id))
    .get()
    .pipe(Effect.orDie)
  if (message !== undefined) return yield* Effect.die(new LifecycleConflict({ id: request.id }))
  const stored = yield* db
    .insert(SessionInboxTable)
    .values({
      id: request.id,
      session_id: request.sessionID,
      type: request.item.type,
      payload:
        request.item.type === "user"
          ? encodeUser(request.item.payload)
          : request.item.type === "synthetic"
            ? encodeSynthetic(request.item.payload)
            : request.item.type === "compaction"
              ? encodeCompaction(request.item.payload)
              : encodeMove(request.item.payload),
      delivery: request.item.delivery,
      enqueued_seq: request.enqueuedSeq,
      time_created: request.timeCreated,
    })
    .onConflictDoNothing()
    .returning({ id: SessionInboxTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!stored) return yield* Effect.die(new LifecycleConflict({ id: request.id }))
})

/**
 * Consume one pending row at promotion. The row's content feeds the projected
 * message insert inside the same event transaction; the deleted row is what
 * makes the table pending-only.
 */
export const projectDelivered = Effect.fn("SessionInbox.projectDelivered")(function* (
  db: DatabaseService,
  input: PendingRef,
) {
  const deleted = yield* db
    .delete(SessionInboxTable)
    .where(and(eq(SessionInboxTable.id, input.id), eq(SessionInboxTable.session_id, input.sessionID)))
    .returning()
    .get()
    .pipe(Effect.orDie)
  if (!deleted) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
  return fromRow(deleted)
})

export const projectCancelled = Effect.fn("SessionInbox.projectCancelled")(function* (
  db: DatabaseService,
  input: PendingRef,
) {
  const deleted = yield* db
    .delete(SessionInboxTable)
    .where(
      and(
        eq(SessionInboxTable.id, input.id),
        eq(SessionInboxTable.session_id, input.sessionID),
        or(eq(SessionInboxTable.delivery, "queue"), eq(SessionInboxTable.delivery, "steer")),
      ),
    )
    .returning({ id: SessionInboxTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!deleted) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

const projectDelivery = Effect.fn("SessionInbox.projectDelivery")(function* (
  db: DatabaseService,
  input: PendingRef & { readonly from: Delivery; readonly to: Delivery },
) {
  const updated = yield* db
    .update(SessionInboxTable)
    .set({ delivery: input.to })
    .where(
      and(
        eq(SessionInboxTable.id, input.id),
        eq(SessionInboxTable.session_id, input.sessionID),
        eq(SessionInboxTable.delivery, input.from),
      ),
    )
    .returning({ id: SessionInboxTable.id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die(new LifecycleConflict({ id: input.id }))
})

export const projectDeliveryChanged = Effect.fn("SessionInbox.projectDeliveryChanged")(
  (db: DatabaseService, input: PendingRef & { readonly delivery: Delivery }) =>
    projectDelivery(db, {
      ...input,
      from: input.delivery === "steer" ? "queue" : "steer",
      to: input.delivery,
    }),
)

export const list = Effect.fn("SessionInbox.list")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const rows = yield* db
    .select()
    .from(SessionInboxTable)
    .where(eq(SessionInboxTable.session_id, sessionID))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .all()
    .pipe(Effect.orDie)
  return rows.map(fromRow)
})
