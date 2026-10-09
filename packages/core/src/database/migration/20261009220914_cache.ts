import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261009220914_cache",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`cache\` (
          \`key\` text PRIMARY KEY,
          \`value\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      // The cached models.dev catalog and repository refresh times move out of the key-value store, which
      // holds state recorded in Specter's log.
      yield* tx.run(`
        INSERT INTO \`cache\` (\`key\`, \`value\`, \`time_created\`, \`time_updated\`)
        SELECT \`key\`, \`value\`, \`time_created\`, \`time_updated\` FROM \`kv\`
        WHERE \`key\` LIKE 'models-dev:%' OR \`key\` LIKE 'repository-cache:%';
      `)
      yield* tx.run(`DELETE FROM \`kv\` WHERE \`key\` LIKE 'models-dev:%' OR \`key\` LIKE 'repository-cache:%';`)
    })
  },
}

export default migration
