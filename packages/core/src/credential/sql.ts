import type { CredentialFact } from "@ocpp/schema/credential-fact"
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql.js"
import type { Credential } from "../credential.js"

/** Credentials, the projection of their facts in Specter's Event Log. */
export const CredentialTable = sqliteTable("credential", {
  id: text().$type<Credential.ID>().primaryKey(),
  integration_id: text().$type<Credential.Info["integrationID"]>().notNull(),
  label: text().notNull(),
  /** Whether the integration uses this credential: exactly one of an integration's credentials is active. */
  active: integer({ mode: "boolean" }).notNull(),
  ...Timestamps,
})

/** Each credential's secret as its latest fact carries it: sealed under the credential's key. */
export const CredentialSecretTable = sqliteTable("credential_secret", {
  credential_id: text()
    .$type<Credential.ID>()
    .primaryKey()
    .references(() => CredentialTable.id, { onDelete: "cascade" }),
  value: text({ mode: "json" }).$type<CredentialFact.Sealed>().notNull(),
})

/**
 * Each credential's key, the one thing about it kept outside the log. It is written in the transaction
 * that records the credential's creation and deleted with the credential, which leaves every sealed
 * copy of its secret, in the log or anywhere else, unreadable.
 */
export const CredentialKeyTable = sqliteTable("credential_key", {
  credential_id: text()
    .$type<Credential.ID>()
    .primaryKey()
    .references(() => CredentialTable.id, { onDelete: "cascade" }),
  key: text().notNull(),
})
