import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261009220615_drop_legacy_tables",
  up(tx) {
    // Tables no code reads or writes any more: console accounts from before integrations, and the
    // pending inbox and project directories, which earlier migrations moved to their successors.
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`session_pending_session_delivery_seq_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_pending_session_compaction_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_pending_session_admitted_seq_idx\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`account_state\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`account\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`control_account\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`project_directory\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`session_pending\`;`)
    })
  },
}

export default migration
