import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260912065059_session_external",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_external\` (
          \`session_id\` text PRIMARY KEY,
          \`provider\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`vendor_session_id\` text,
          \`checkpoint\` text,
          \`status\` text NOT NULL,
          CONSTRAINT \`fk_session_external_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
}

export default migration
