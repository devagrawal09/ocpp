import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260928161342_tool_lists",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`codemode_execution\` ADD \`tools\` text;`)
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`tools\` text;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`permission_project_action_resource_idx\`;`)
      yield* tx.run(`DROP TABLE \`permission\`;`)
    })
  },
}

export default migration
