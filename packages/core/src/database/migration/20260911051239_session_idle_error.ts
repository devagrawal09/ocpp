import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260911051239_session_idle_error",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`idle_error_type\` text;`)
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`idle_error_message\` text;`)
    })
  },
}

export default migration
