export * as Credential from "./credential.js"

import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Credential } from "@ocpp/schema/credential"
import { CredentialFact } from "@ocpp/schema/credential-fact"
import { Integration } from "@ocpp/schema/integration"
import { Database } from "./database/database.js"
import { Bus } from "./bus.js"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { CredentialSeal } from "./credential/seal.js"
import { CredentialKeyTable, CredentialSecretTable, CredentialTable } from "./credential/sql.js"
import { SpecterRejection } from "./specter/rejection.js"

export const ID = Credential.ID
export type ID = Credential.ID

export const OAuth = Credential.OAuth
export type OAuth = Credential.OAuth

export const Key = Credential.Key
export type Key = Credential.Key

export const Value = Credential.Value
export type Value = Credential.Value

export const Event = Credential.Event

export class Info extends Schema.Class<Info>("Credential.Info")({
  id: ID,
  integrationID: Integration.ID,
  label: Schema.String,
  value: Value,
}) {}

export interface Interface {
  /** Returns every stored credential. */
  readonly all: () => Effect.Effect<Info[]>
  /** Returns stored credentials belonging to one integration. */
  readonly list: (integrationID: Integration.ID) => Effect.Effect<Info[]>
  /** Returns one stored credential by ID. */
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  /** Creates a credential for an integration and returns the new record. */
  readonly create: (input: {
    readonly integrationID: Integration.ID
    readonly value: Value
    readonly label?: string
  }) => Effect.Effect<Info>
  /** Selects a stored credential for its integration. */
  readonly activate: (id: ID) => Effect.Effect<void>
  /** Updates the label or secret value of a stored credential. */
  readonly update: (id: ID, updates: Partial<Pick<Info, "label" | "value">>) => Effect.Effect<void>
  /** Removes a stored credential. */
  readonly remove: (id: ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/Credential") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const bus = yield* Bus.Service
    const decode = Schema.decodeUnknownSync(Value)

    // Credentials are the projection of their facts in Specter's Event Log, which the runtime's credential
    // Commands decide: which credential an integration uses, and which replaces a removed one. A fact carries
    // the secret sealed under the credential's key, which the dispatch of its creation stores beside the log,
    // in the same transaction (`keyed`).
    const activate = (integrationID: Integration.ID, credentialID: ID, time: number) =>
      Effect.gen(function* () {
        yield* db
          .update(CredentialTable)
          .set({ active: false, time_updated: time })
          .where(eq(CredentialTable.integration_id, integrationID))
          .run()
        yield* db
          .update(CredentialTable)
          .set({ active: true, time_updated: time })
          .where(eq(CredentialTable.id, credentialID))
          .run()
      }).pipe(Effect.orDie)
    yield* bus.project(CredentialFact.Created, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(CredentialTable)
          .set({ active: false, time_updated: event.created })
          .where(eq(CredentialTable.integration_id, event.data.integrationID))
          .run()
        yield* db
          .insert(CredentialTable)
          .values({
            id: event.data.credentialID,
            integration_id: event.data.integrationID,
            label: event.data.label,
            active: true,
            time_created: event.created,
            time_updated: event.created,
          })
          .run()
        yield* db
          .insert(CredentialSecretTable)
          .values({ credential_id: event.data.credentialID, value: event.data.secret })
          .run()
      }).pipe(Effect.orDie),
    )
    yield* bus.project(CredentialFact.Activated, (event) =>
      activate(event.data.integrationID, event.data.credentialID, event.created),
    )
    yield* bus.project(CredentialFact.Relabeled, (event) =>
      db
        .update(CredentialTable)
        .set({ label: event.data.label, time_updated: event.created })
        .where(eq(CredentialTable.id, event.data.credentialID))
        .run()
        .pipe(Effect.orDie, Effect.asVoid),
    )
    yield* bus.project(CredentialFact.Rotated, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(CredentialTable)
          .set({ time_updated: event.created })
          .where(eq(CredentialTable.id, event.data.credentialID))
          .run()
        yield* db
          .insert(CredentialSecretTable)
          .values({ credential_id: event.data.credentialID, value: event.data.secret })
          .onConflictDoUpdate({ target: CredentialSecretTable.credential_id, set: { value: event.data.secret } })
          .run()
      }).pipe(Effect.orDie),
    )
    yield* bus.project(CredentialFact.Removed, (event) =>
      Effect.gen(function* () {
        // The secret and its key go with the row, so no sealed copy of the secret can be read again.
        yield* db
          .delete(CredentialTable)
          .where(eq(CredentialTable.id, event.data.credentialID))
          .run()
          .pipe(Effect.orDie)
        if (event.data.replacement) yield* activate(event.data.integrationID, event.data.replacement, event.created)
      }),
    )
    const keyed = (credentialID: ID, key: string) => ({
      commit: () =>
        db
          .insert(CredentialKeyTable)
          .values({ credential_id: credentialID, key })
          .run()
          .pipe(Effect.orDie, Effect.asVoid),
    })
    const keyOf = (credentialID: ID) =>
      db
        .select({ key: CredentialKeyTable.key })
        .from(CredentialKeyTable)
        .where(eq(CredentialKeyTable.credential_id, credentialID))
        .get()
        .pipe(
          Effect.orDie,
          Effect.map((row) => row?.key),
        )

    const columns = {
      id: CredentialTable.id,
      integration_id: CredentialTable.integration_id,
      label: CredentialTable.label,
      sealed: CredentialSecretTable.value,
      key: CredentialKeyTable.key,
    }
    type Row = {
      id: ID
      integration_id: Integration.ID
      label: string
      sealed: CredentialFact.Sealed
      key: string
    }
    const stored = (row: Row) =>
      Effect.gen(function* () {
        return new Info({
          id: row.id,
          integrationID: row.integration_id,
          label: row.label,
          value: decode(yield* CredentialSeal.open(row.key, row.sealed)),
        })
      })
    const storedRows = (rows: ReadonlyArray<Row>) => Effect.forEach(rows, stored)
    const select = () =>
      db
        .select(columns)
        .from(CredentialTable)
        .innerJoin(CredentialSecretTable, eq(CredentialSecretTable.credential_id, CredentialTable.id))
        .innerJoin(CredentialKeyTable, eq(CredentialKeyTable.credential_id, CredentialTable.id))
    // The credential an integration uses.
    const current = (integrationID: Integration.ID) =>
      db
        .select({ id: CredentialTable.id })
        .from(CredentialTable)
        .where(and(eq(CredentialTable.integration_id, integrationID), eq(CredentialTable.active, true)))
        .get()
        .pipe(Effect.orDie)
    return Service.of({
      all: Effect.fn("Credential.all")(() =>
        select()
          .orderBy(asc(CredentialTable.active), asc(CredentialTable.time_created), asc(CredentialTable.id))
          .all()
          .pipe(Effect.orDie, Effect.flatMap(storedRows)),
      ),
      list: Effect.fn("Credential.list")((integrationID) =>
        select()
          .where(eq(CredentialTable.integration_id, integrationID))
          .orderBy(asc(CredentialTable.active), asc(CredentialTable.time_created), asc(CredentialTable.id))
          .all()
          .pipe(Effect.orDie, Effect.flatMap(storedRows)),
      ),
      get: Effect.fn("Credential.get")(function* (id) {
        const row = yield* select().where(eq(CredentialTable.id, id)).get().pipe(Effect.orDie)
        return row ? yield* stored(row) : undefined
      }),
      create: Effect.fn("Credential.create")(function* (input) {
        const credential = new Info({
          id: ID.create(),
          integrationID: input.integrationID,
          label: input.label ?? "default",
          value: input.value,
        })
        const key = CredentialSeal.generateKey()
        yield* bus
          .command(
            {
              type: "createCredential",
              payload: {
                credentialID: credential.id,
                integrationID: credential.integrationID,
                label: credential.label,
                secret: yield* CredentialSeal.seal(key, credential.value),
              },
            },
            { facts: [keyed(credential.id, key)] },
          )
          .pipe(Effect.orDie)
        yield* bus.publish(Event.Updated, {}, { global: true })
        yield* bus.publish(
          Event.Switched,
          { integrationID: credential.integrationID, credentialID: credential.id },
          { global: true },
        )
        return credential
      }),
      activate: Effect.fn("Credential.activate")(function* (id) {
        const activated = yield* bus
          .command({ type: "activateCredential", payload: { credentialID: id } })
          .pipe(unless("Credential not found", "Credential already active"))
        yield* Effect.forEach(
          activated,
          (fact) => bus.publish(Event.Switched, fact.data as typeof Event.Switched.Type.data, { global: true }),
          { discard: true },
        )
      }),
      update: Effect.fn("Credential.update")(function* (id, updates) {
        if (updates.label === undefined && updates.value === undefined) return
        // The new secret is sealed under the credential's own key. A credential removed meanwhile has none, and
        // nothing to update.
        const key = updates.value === undefined ? undefined : yield* keyOf(id)
        if (updates.value !== undefined && key === undefined) return
        const facts = yield* bus
          .command({
            type: "updateCredential",
            payload: {
              credentialID: id,
              ...(updates.label === undefined ? {} : { label: updates.label }),
              ...(updates.value === undefined || key === undefined
                ? {}
                : { secret: yield* CredentialSeal.seal(key, updates.value) }),
            },
          })
          .pipe(unless("Credential not found", "Credential unchanged"))
        if (facts.some((fact) => fact.type === CredentialFact.Relabeled.type))
          yield* bus.publish(Event.Updated, {}, { global: true })
      }),
      remove: Effect.fn("Credential.remove")(function* (id) {
        const removed = yield* bus
          .command({ type: "removeCredential", payload: { credentialID: id } })
          .pipe(unless("Credential not found"))
        if (removed.length === 0) return
        yield* bus.publish(Event.Updated, {}, { global: true })
        const data = removed[0]!.data as typeof CredentialFact.Removed.Type.data
        // When the removed credential was in use, the integration switches to its replacement, or to none.
        if (data.replacement !== undefined || (yield* current(data.integrationID)) === undefined)
          yield* bus.publish(
            Event.Switched,
            { integrationID: data.integrationID, credentialID: data.replacement ?? null },
            { global: true },
          )
      }),
    })
  }),
)

/** A dispatch whose rejection for one of `reasons` records nothing; any other failure is a defect. */
const unless =
  (...reasons: ReadonlyArray<string>) =>
  <A, E>(effect: Effect.Effect<ReadonlyArray<A>, E>) =>
    effect.pipe(
      Effect.catchIf(
        (error) => reasons.includes(SpecterRejection.reason(error) ?? ""),
        () => Effect.succeed([]),
      ),
      Effect.orDie,
    )

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node] })
