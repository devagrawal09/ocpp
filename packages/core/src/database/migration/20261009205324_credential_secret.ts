import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261009205324_credential_secret",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`credential_secret\` (
          \`credential_id\` text PRIMARY KEY,
          \`value\` text NOT NULL,
          CONSTRAINT \`fk_credential_secret_credential_id_credential_id_fk\` FOREIGN KEY (\`credential_id\`) REFERENCES \`credential\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // Every stored secret moves to the new table before the column goes.
      yield* tx.run(
        `INSERT INTO \`credential_secret\` (\`credential_id\`, \`value\`) SELECT \`id\`, \`value\` FROM \`credential\`;`,
      )
      yield* tx.run(`ALTER TABLE \`credential\` DROP COLUMN \`value\`;`)
    })
  },
}

export default migration
