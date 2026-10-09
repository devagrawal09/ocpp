import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261009133447_specter_event_log",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`specter_commit\` (
          \`version\` integer PRIMARY KEY,
          \`idempotency_key\` text UNIQUE,
          \`fingerprint\` text,
          \`first_order\` integer NOT NULL,
          \`committed_at\` text NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`specter_event\` (
          \`order\` integer PRIMARY KEY AUTOINCREMENT,
          \`id\` text NOT NULL UNIQUE,
          \`type\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`recorded_at\` text NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`specter_event_type_order_idx\` ON \`specter_event\` (\`type\`,\`order\`);`)
    })
  },
}

export default migration
