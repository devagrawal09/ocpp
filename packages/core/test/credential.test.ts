import { describe, expect } from "bun:test"
import { EventManifest } from "@ocpp/schema/event-manifest"
import { like } from "drizzle-orm"
import { Effect } from "effect"
import { Bus } from "@ocpp/core/bus"
import { Credential } from "@ocpp/core/credential"
import { CredentialFact } from "@ocpp/schema/credential-fact"
import { CredentialSeal } from "@ocpp/core/credential/seal"
import { CredentialKeyTable, CredentialSecretTable } from "@ocpp/core/credential/sql"
import { SpecterEventTable } from "@ocpp/core/specter/sql"
import { Database } from "@ocpp/core/database/database"
import { Location } from "@ocpp/core/location"
import { AbsolutePath } from "@ocpp/core/schema"
import { Workspace } from "@ocpp/core/workspace"
import { Event } from "@ocpp/schema/event"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Integration } from "@ocpp/core/integration"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Credential.node, Bus.node, Database.node])))

describe("Credential", () => {
  it.effect("records a credential's secret in Specter's log sealed under a key that removal erases", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const { db } = yield* Database.Service
      const integrationID = Integration.ID.make("openai")
      const created = yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "sk-never-logged" }),
      })
      yield* credentials.update(created.id, { value: Credential.Key.make({ type: "key", key: "sk-rotated" }) })
      expect((yield* credentials.get(created.id))?.value).toEqual({ type: "key", key: "sk-rotated" })

      const facts = yield* db
        .select({ type: SpecterEventTable.type, payload: SpecterEventTable.payload })
        .from(SpecterEventTable)
        .where(like(SpecterEventTable.type, "credential-%"))
        .all()
        .pipe(Effect.orDie)
      expect(facts.map((fact) => fact.type)).toEqual(["credential-created", "credential-rotated"])
      expect(JSON.stringify(facts)).not.toContain("sk-")

      // Each fact carries the secret of its time, which the credential's key opens.
      const key = (yield* db.select().from(CredentialKeyTable).get().pipe(Effect.orDie))!.key
      const secrets = facts.map((fact) => (fact.payload as { readonly secret: CredentialFact.Sealed }).secret)
      expect(yield* Effect.forEach(secrets, (secret) => CredentialSeal.open(key, secret))).toEqual([
        { type: "key", key: "sk-never-logged" },
        { type: "key", key: "sk-rotated" },
      ])

      // Removal erases the key with the credential: what the log keeps of its secret can no longer be read.
      yield* credentials.remove(created.id)
      expect(yield* db.select().from(CredentialSecretTable).all().pipe(Effect.orDie)).toEqual([])
      expect(yield* db.select().from(CredentialKeyTable).all().pipe(Effect.orDie)).toEqual([])
      expect(
        yield* db
          .select({ type: SpecterEventTable.type })
          .from(SpecterEventTable)
          .where(like(SpecterEventTable.type, "credential-%"))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(3)
    }),
  )

  it.effect("stores, updates, lists, and removes credentials", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const created = yield* credentials.create({
        integrationID,
        label: "Work",
        value: Credential.Key.make({ type: "key", key: "secret" }),
      })

      expect(yield* credentials.list(integrationID)).toEqual([created])
      yield* credentials.update(created.id, { label: "Personal" })
      expect((yield* credentials.list(integrationID))[0]?.label).toBe("Personal")

      const additional = yield* credentials.create({
        integrationID,
        label: "Additional",
        value: Credential.Key.make({ type: "key", key: "additional" }),
      })
      expect(yield* credentials.list(integrationID)).toEqual([
        expect.objectContaining({ id: created.id, label: "Personal" }),
        additional,
      ])

      yield* credentials.remove(additional.id)
      expect(yield* credentials.list(integrationID)).toEqual([
        expect.objectContaining({ id: created.id, label: "Personal" }),
      ])
    }),
  )

  it.effect("publishes global events only for observable credential mutations", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const bus = yield* Bus.Service
      const integrationID = Integration.ID.make("openai")
      const events = new Array<Event.Payload>()
      // What clients see: credentials' own facts stay internal.
      yield* bus.listen((event) => Effect.sync(() => EventManifest.isServer(event) && events.push(event)))

      const older = yield* credentials
        .create({ integrationID, value: Credential.Key.make({ type: "key", key: "older" }) })
        .pipe(
          Effect.provideService(
            Location.Service,
            Location.Service.of(
              location({ directory: AbsolutePath.make("project"), workspaceID: Workspace.ID.make("wrk_test") }),
            ),
          ),
        )
      const newer = yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "newer" }),
      })

      yield* credentials.activate(newer.id)
      yield* credentials.activate(Credential.ID.create())
      yield* credentials.activate(older.id)
      yield* credentials.activate(older.id)
      yield* credentials.update(older.id, {})
      yield* credentials.update(Credential.ID.create(), { label: "Missing" })
      yield* credentials.update(older.id, { label: "default" })
      yield* credentials.update(older.id, { value: Credential.Key.make({ type: "key", key: "refreshed" }) })
      yield* credentials.update(older.id, { label: "Renamed" })
      yield* credentials.remove(Credential.ID.create())
      yield* credentials.remove(newer.id)
      yield* credentials.remove(newer.id)
      expect((yield* credentials.list(integrationID)).at(-1)?.id).toBe(older.id)

      const replacement = yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "replacement" }),
      })
      yield* credentials.remove(replacement.id)
      expect((yield* credentials.list(integrationID)).at(-1)?.id).toBe(older.id)
      yield* credentials.remove(older.id)
      expect(yield* credentials.list(integrationID)).toEqual([])

      expect(events.map((event) => ({ type: event.type, data: event.data }))).toEqual([
        { type: Credential.Event.Updated.type, data: {} },
        { type: Credential.Event.Switched.type, data: { integrationID, credentialID: older.id } },
        { type: Credential.Event.Updated.type, data: {} },
        { type: Credential.Event.Switched.type, data: { integrationID, credentialID: newer.id } },
        { type: Credential.Event.Switched.type, data: { integrationID, credentialID: older.id } },
        { type: Credential.Event.Updated.type, data: {} },
        { type: Credential.Event.Updated.type, data: {} },
        { type: Credential.Event.Updated.type, data: {} },
        { type: Credential.Event.Switched.type, data: { integrationID, credentialID: replacement.id } },
        { type: Credential.Event.Updated.type, data: {} },
        { type: Credential.Event.Switched.type, data: { integrationID, credentialID: older.id } },
        { type: Credential.Event.Updated.type, data: {} },
        { type: Credential.Event.Switched.type, data: { integrationID, credentialID: null } },
      ])
      expect(events.every((event) => !("location" in event))).toBeTrue()
    }),
  )

  it.effect("activates older credentials without affecting other integrations", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const integrationID = Integration.ID.make("openai")
      const otherIntegrationID = Integration.ID.make("anthropic")
      const older = yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "older" }),
      })
      const newer = yield* credentials.create({
        integrationID,
        value: Credential.Key.make({ type: "key", key: "newer" }),
      })
      const otherOlder = yield* credentials.create({
        integrationID: otherIntegrationID,
        value: Credential.Key.make({ type: "key", key: "other-older" }),
      })
      const otherNewer = yield* credentials.create({
        integrationID: otherIntegrationID,
        value: Credential.Key.make({ type: "key", key: "other-newer" }),
      })

      yield* credentials.activate(older.id)
      expect(yield* credentials.list(integrationID)).toEqual([newer, older])
      expect(yield* credentials.list(otherIntegrationID)).toEqual([otherOlder, otherNewer])

      yield* credentials.activate(Credential.ID.create())
      expect((yield* credentials.list(integrationID)).at(-1)).toEqual(older)

      yield* credentials.activate(otherOlder.id)
      expect(yield* credentials.list(otherIntegrationID)).toEqual([otherNewer, otherOlder])
      expect((yield* credentials.list(integrationID)).at(-1)).toEqual(older)

      yield* credentials.remove(older.id)
      expect((yield* credentials.list(integrationID)).at(-1)).toEqual(newer)
      expect((yield* credentials.list(otherIntegrationID)).at(-1)).toEqual(otherOlder)
    }),
  )
})
