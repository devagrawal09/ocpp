import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261009195033_specter_runtime_state",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`specter_outbox_job\` (
          \`id\` text PRIMARY KEY,
          \`reaction\` text NOT NULL,
          \`idempotency_key\` text NOT NULL,
          \`concurrency_key\` text,
          \`payload\` text NOT NULL,
          \`status\` text NOT NULL,
          \`requested_at\` integer NOT NULL,
          \`available_at\` integer NOT NULL,
          \`attempt_count\` integer NOT NULL,
          \`active_attempt_id\` text,
          \`lease_expires_at\` integer,
          \`completed_at\` integer,
          \`last_error\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`specter_slice_snapshot\` (
          \`slice\` text PRIMARY KEY,
          \`state\` text NOT NULL,
          \`cursor\` integer NOT NULL,
          \`saved_at\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`specter_outbox_job_key_idx\` ON \`specter_outbox_job\` (\`reaction\`,\`idempotency_key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`specter_outbox_job_claim_idx\` ON \`specter_outbox_job\` (\`reaction\`,\`status\`,\`available_at\`);`,
      )
    })
  },
}

export default migration
