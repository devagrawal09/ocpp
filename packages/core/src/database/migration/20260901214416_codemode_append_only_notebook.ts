import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

// The previous experimental notebook stored revisions, durable result blobs, and mutable bindings.
// None of that has a meaning in the append-only notebook, so the old tables are dropped rather than
// translated.
const migration: DatabaseMigration.Migration = {
  id: "20260901214416_codemode_append_only_notebook",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP TABLE IF EXISTS \`codemode_result\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`codemode_journal\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`codemode_activation\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`codemode_binding_history\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`codemode_binding\`;`)
      yield* tx.run(`DROP TABLE IF EXISTS \`codemode_notebook\`;`)
      yield* tx.run(`
        CREATE TABLE \`codemode_binding\` (
          \`session_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`value\` text NOT NULL,
          \`message_seq\` integer NOT NULL,
          \`execution_id\` text NOT NULL,
          CONSTRAINT \`codemode_binding_pk\` PRIMARY KEY(\`session_id\`, \`name\`),
          CONSTRAINT \`fk_codemode_binding_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`codemode_execution\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`assistant_message_id\` text NOT NULL,
          \`tool_call_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`program\` text NOT NULL,
          \`ir_version\` integer NOT NULL,
          \`snapshot\` text NOT NULL,
          \`saved\` text,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_codemode_execution_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`codemode_journal\` (
          \`execution_id\` text NOT NULL,
          \`call_index\` integer NOT NULL,
          \`tool\` text NOT NULL,
          \`input\` text NOT NULL,
          \`status\` text NOT NULL,
          \`output\` text,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`codemode_journal_pk\` PRIMARY KEY(\`execution_id\`, \`call_index\`),
          CONSTRAINT \`fk_codemode_journal_execution_id_codemode_execution_id_fk\` FOREIGN KEY (\`execution_id\`) REFERENCES \`codemode_execution\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`codemode_reservation\` (
          \`session_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`execution_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`codemode_reservation_pk\` PRIMARY KEY(\`session_id\`, \`name\`),
          CONSTRAINT \`fk_codemode_reservation_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`DROP INDEX IF EXISTS \`codemode_activation_session_created_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`codemode_binding_history_session_name_revision_idx\`;`)
      yield* tx.run(
        `CREATE INDEX \`codemode_binding_session_seq_idx\` ON \`codemode_binding\` (\`session_id\`,\`message_seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`codemode_execution_session_created_idx\` ON \`codemode_execution\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`codemode_reservation_execution_idx\` ON \`codemode_reservation\` (\`execution_id\`);`,
      )
    })
  },
}

export default migration
