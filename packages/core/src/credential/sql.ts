import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql.js"
import type { Credential } from "../credential.js"

/** Credentials, the projection of their facts in Specter's Event Log. Their secrets are kept apart. */
export const CredentialTable = sqliteTable("credential", {
  id: text().$type<Credential.ID>().primaryKey(),
  integration_id: text().$type<Credential.Info["integrationID"]>(),
  label: text().notNull(),
  connector_id: text(),
  method_id: text(),
  active: integer({ mode: "boolean" }),
  ...Timestamps,
})

/**
 * Each credential's secret, outside the log because an append-only log cannot forget one. It is written
 * in the transaction that records the credential's fact and deleted with the credential.
 */
export const CredentialSecretTable = sqliteTable("credential_secret", {
  credential_id: text()
    .$type<Credential.ID>()
    .primaryKey()
    .references(() => CredentialTable.id, { onDelete: "cascade" }),
  value: text({ mode: "json" }).$type<Credential.Value>().notNull(),
})
