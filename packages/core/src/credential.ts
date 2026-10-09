export * as Credential from "./credential.js"

import { and, asc, desc, eq, ne } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Credential } from "@ocpp/schema/credential"
import { CredentialFact } from "@ocpp/schema/credential-fact"
import { Integration } from "@ocpp/schema/integration"
import { Database } from "./database/database.js"
import { Bus } from "./bus.js"
import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { CredentialSeal } from "./credential/seal.js"
import { CredentialKeyTable, CredentialSecretTable, CredentialTable } from "./credential/sql.js"
import { KeyedMutex } from "./effect/keyed-mutex.js"

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
    // An integration's credentials are decided one at a time: which is active, which replaces it.
    const locks = KeyedMutex.makeUnsafe<string>()

    // Credentials are the projection of their facts in Specter's Event Log. A fact carries the secret
    // sealed under the credential's key, which the publish of its creation stores beside the log, in the
    // same transaction (`keyed`).
    const activate = (integrationID: Integration.ID, credentialID: ID) =>
      Effect.gen(function* () {
        yield* db
          .update(CredentialTable)
          .set({ active: false })
          .where(eq(CredentialTable.integration_id, integrationID))
          .run()
        yield* db.update(CredentialTable).set({ active: true }).where(eq(CredentialTable.id, credentialID)).run()
      }).pipe(Effect.orDie)
    yield* bus.project(CredentialFact.Created, (event) =>
      Effect.gen(function* () {
        yield* db
          .update(CredentialTable)
          .set({ active: false })
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
    yield* bus.project(CredentialFact.Activated, (event) => activate(event.data.integrationID, event.data.credentialID))
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
        if (event.data.integrationID && event.data.replacement)
          yield* activate(event.data.integrationID, event.data.replacement)
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
          Effect.flatMap((row) =>
            row ? Effect.succeed(row.key) : Effect.die(new Error(`Credential ${credentialID} has no key`)),
          ),
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
      integration_id: Integration.ID | null
      label: string
      sealed: CredentialFact.Sealed
      key: string
    }
    const stored = (row: Row) =>
      Effect.gen(function* () {
        if (!row.integration_id) return undefined
        return new Info({
          id: row.id,
          integrationID: row.integration_id,
          label: row.label,
          value: decode(yield* CredentialSeal.open(row.key, row.sealed)),
        })
      })
    const storedRows = (rows: ReadonlyArray<Row>) =>
      Effect.forEach(rows, stored).pipe(
        Effect.map((credentials) => credentials.flatMap((credential) => (credential ? [credential] : []))),
      )
    const select = () =>
      db
        .select(columns)
        .from(CredentialTable)
        .innerJoin(CredentialSecretTable, eq(CredentialSecretTable.credential_id, CredentialTable.id))
        .innerJoin(CredentialKeyTable, eq(CredentialKeyTable.credential_id, CredentialTable.id))
    // The credential an integration uses: the active one, else the newest.
    const current = (integrationID: Integration.ID) =>
      db
        .select({ id: CredentialTable.id })
        .from(CredentialTable)
        .where(eq(CredentialTable.integration_id, integrationID))
        .orderBy(desc(CredentialTable.active), desc(CredentialTable.time_created), desc(CredentialTable.id))
        .get()
        .pipe(Effect.orDie)
    const find = (id: ID) =>
      db.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get().pipe(Effect.orDie)

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
        const sealed = yield* CredentialSeal.seal(key, credential.value)
        yield* locks.withLock(credential.integrationID)(
          bus.publish(
            CredentialFact.Created,
            {
              credentialID: credential.id,
              integrationID: credential.integrationID,
              label: credential.label,
              secret: sealed,
            },
            keyed(credential.id, key),
          ),
        )
        yield* bus.publish(Event.Updated, {}, { global: true })
        yield* bus.publish(
          Event.Switched,
          { integrationID: credential.integrationID, credentialID: credential.id },
          { global: true },
        )
        return credential
      }),
      activate: Effect.fn("Credential.activate")(function* (id) {
        const credential = yield* find(id)
        const integrationID = credential?.integration_id
        if (!integrationID) return
        const switched = yield* locks.withLock(integrationID)(
          Effect.gen(function* () {
            if ((yield* current(integrationID))?.id === id) return false
            yield* bus.publish(CredentialFact.Activated, { credentialID: id, integrationID })
            return true
          }),
        )
        if (switched) yield* bus.publish(Event.Switched, { integrationID, credentialID: id }, { global: true })
      }),
      update: Effect.fn("Credential.update")(function* (id, updates) {
        if (updates.label === undefined && updates.value === undefined) return
        const credential = yield* find(id)
        const integrationID = credential?.integration_id
        if (!credential || !integrationID) return
        const relabeled = updates.label !== undefined && updates.label !== credential.label
        if (relabeled)
          yield* bus.publish(CredentialFact.Relabeled, { credentialID: id, integrationID, label: updates.label! })
        if (updates.value !== undefined)
          yield* bus.publish(CredentialFact.Rotated, {
            credentialID: id,
            integrationID,
            secret: yield* CredentialSeal.seal(yield* keyOf(id), updates.value),
          })
        if (relabeled) yield* bus.publish(Event.Updated, {}, { global: true })
      }),
      remove: Effect.fn("Credential.remove")(function* (id) {
        const credential = yield* find(id)
        if (!credential) return
        const integrationID = credential.integration_id ?? undefined
        const removed = yield* (integrationID ? locks.withLock(integrationID) : <A>(effect: A) => effect)(
          Effect.gen(function* () {
            const active = integrationID ? yield* current(integrationID) : undefined
            // When the removed credential was in use, the newest remaining one replaces it.
            const replacement =
              integrationID && active?.id === id
                ? yield* db
                    .select({ id: CredentialTable.id })
                    .from(CredentialTable)
                    .where(and(eq(CredentialTable.integration_id, integrationID), ne(CredentialTable.id, id)))
                    .orderBy(desc(CredentialTable.time_created), desc(CredentialTable.id))
                    .get()
                    .pipe(Effect.orDie)
                : undefined
            yield* bus.publish(CredentialFact.Removed, {
              credentialID: id,
              ...(integrationID === undefined ? {} : { integrationID }),
              ...(replacement === undefined ? {} : { replacement: replacement.id }),
            })
            return integrationID && active?.id === id
              ? { switched: true as const, integrationID, credentialID: replacement?.id ?? null }
              : { switched: false as const }
          }),
        )
        yield* bus.publish(Event.Updated, {}, { global: true })
        if (removed.switched)
          yield* bus.publish(
            Event.Switched,
            { integrationID: removed.integrationID, credentialID: removed.credentialID },
            { global: true },
          )
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, Bus.node] })
