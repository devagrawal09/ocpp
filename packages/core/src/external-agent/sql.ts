import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { ExternalSession } from "@ocpp/schema/external-session"
import { SessionTable } from "../session/sql.js"
import { directoryColumn } from "../database/path.js"

export const ExternalSessionTable = sqliteTable("session_external", {
  session_id: text()
    .$type<ExternalSession.Info["sessionID"]>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  provider: text().$type<ExternalSession.Provider>().notNull(),
  directory: directoryColumn().notNull(),
  vendor_session_id: text(),
  checkpoint: text(),
  history_hash: text(),
  /** Notebook identifiers checkpointed into the linked vendor session's instructions, fixed for its lifetime. */
  notebook: text({ mode: "json" }).$type<ReadonlyArray<string>>(),
  status: text().$type<ExternalSession.Status>().notNull(),
})
