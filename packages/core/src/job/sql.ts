import type { SessionFact } from "@ocpp/schema/session-fact"
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import type { SessionMessage } from "../session/message.js"

/**
 * Recoverable background jobs whose notification has not been delivered, the projection of their facts
 * in Specter's Event Log. Restart recovery resumes each one, or delivers the outcome it reached.
 */
export const JobBackgroundTable = sqliteTable(
  "job_background",
  {
    notification_id: text().$type<SessionMessage.ID>().primaryKey(),
    job_id: text().notNull(),
    recovery: text({ mode: "json" }).$type<SessionFact.BackgroundRecovery>().notNull(),
    status: text().$type<"running" | "completed" | "error" | "cancelled">().notNull(),
    /** The job's outcome reached its Session; only the notification is left to deliver. */
    terminal: integer({ mode: "boolean" }).notNull().default(false),
    output: text(),
    error: text(),
  },
  (table) => [index("job_background_job_idx").on(table.job_id)],
)
