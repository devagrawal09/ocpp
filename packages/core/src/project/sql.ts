import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { absoluteArrayColumn, absoluteColumn } from "../database/path.js"
import { Timestamps } from "../database/schema.sql.js"
import { ProjectSchema } from "./schema.js"

export const ProjectTable = sqliteTable("project", {
  id: text().$type<ProjectSchema.ID>().primaryKey(),
  worktree: absoluteColumn().notNull(),
  vcs: text().$type<ProjectSchema.Vcs["type"]>(),
  name: text(),
  icon_url: text(),
  icon_url_override: text(),
  icon_color: text(),
  ...Timestamps,
  time_initialized: integer(),
  sandboxes: absoluteArrayColumn().notNull(),
  commands: text({ mode: "json" }).$type<{ start?: string }>(),
})
