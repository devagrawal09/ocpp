import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260930223025_notebook_checkpoint",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_external\` ADD \`notebook\` text;`)
      yield* tx.run(`ALTER TABLE \`instruction_state\` ADD \`notebook\` text DEFAULT '[]' NOT NULL;`)
      // Existing baselines and linked vendor sessions checkpoint the notebook as it stands at upgrade.
      yield* tx.run(
        `UPDATE \`instruction_state\` SET \`notebook\` = (SELECT json_group_array(\`name\`) FROM \`codemode_binding\` WHERE \`codemode_binding\`.\`session_id\` = \`instruction_state\`.\`session_id\`);`,
      )
      yield* tx.run(
        `UPDATE \`session_external\` SET \`notebook\` = (SELECT json_group_array(\`name\`) FROM \`codemode_binding\` WHERE \`codemode_binding\`.\`session_id\` = \`session_external\`.\`session_id\`) WHERE \`vendor_session_id\` IS NOT NULL;`,
      )
    })
  },
}

export default migration
