import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260927095058_codemode_resume",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`codemode_execution\` ADD \`input\` text;`)
      yield* tx.run(`ALTER TABLE \`codemode_execution\` ADD \`resumes\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`codemode_journal\` ADD \`omitted\` integer DEFAULT false NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`codemode_journal\` ADD \`impure\` text;`)
      yield* tx.run(`ALTER TABLE \`codemode_journal\` ADD \`progress\` text;`)
    })
  },
}

export default migration
