import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260901061131_codemode_notebook",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`codemode_activation\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`assistant_message_id\` text NOT NULL,
          \`tool_call_id\` text NOT NULL,
          \`base_revision\` integer NOT NULL,
          \`mode\` text NOT NULL,
          \`status\` text NOT NULL,
          \`program\` text NOT NULL,
          \`ir_version\` integer NOT NULL,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_codemode_activation_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`codemode_binding_history\` (
          \`session_id\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`message_seq\` integer NOT NULL,
          \`name\` text NOT NULL,
          \`value\` text NOT NULL,
          CONSTRAINT \`codemode_binding_history_pk\` PRIMARY KEY(\`session_id\`, \`revision\`, \`name\`),
          CONSTRAINT \`fk_codemode_binding_history_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`codemode_binding\` (
          \`session_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`value\` text NOT NULL,
          CONSTRAINT \`codemode_binding_pk\` PRIMARY KEY(\`session_id\`, \`name\`),
          CONSTRAINT \`fk_codemode_binding_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`codemode_journal\` (
          \`activation_id\` text NOT NULL,
          \`call_index\` integer NOT NULL,
          \`tool\` text NOT NULL,
          \`input\` text NOT NULL,
          \`status\` text NOT NULL,
          \`output\` text,
          \`error\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`codemode_journal_pk\` PRIMARY KEY(\`activation_id\`, \`call_index\`),
          CONSTRAINT \`fk_codemode_journal_activation_id_codemode_activation_id_fk\` FOREIGN KEY (\`activation_id\`) REFERENCES \`codemode_activation\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`codemode_notebook\` (
          \`session_id\` text PRIMARY KEY,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_codemode_notebook_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`codemode_result\` (
          \`activation_id\` text PRIMARY KEY,
          \`status\` text NOT NULL,
          \`data\` text NOT NULL,
          \`bytes\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_codemode_result_activation_id_codemode_activation_id_fk\` FOREIGN KEY (\`activation_id\`) REFERENCES \`codemode_activation\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`codemode_activation_session_created_idx\` ON \`codemode_activation\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`codemode_binding_history_session_name_revision_idx\` ON \`codemode_binding_history\` (\`session_id\`,\`name\`,\`revision\`);`,
      )
    })
  },
}

export default migration
