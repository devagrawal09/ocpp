import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20260927100205_codemode_commands_events",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`codemode_command\` (
          \`session_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`description\` text NOT NULL,
          \`handler\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`codemode_command_pk\` PRIMARY KEY(\`session_id\`, \`name\`),
          CONSTRAINT \`fk_codemode_command_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`codemode_event\` (
          \`session_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`description\` text NOT NULL,
          \`schedule\` text NOT NULL,
          \`handler\` text NOT NULL,
          \`input\` text,
          \`enabled\` integer NOT NULL,
          \`time_next\` integer,
          \`time_fired\` integer,
          \`execution_id\` text,
          \`message_id\` text,
          \`error\` text,
          \`run_count\` integer DEFAULT 0 NOT NULL,
          \`skip_count\` integer DEFAULT 0 NOT NULL,
          \`time_skipped\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`codemode_event_pk\` PRIMARY KEY(\`session_id\`, \`name\`),
          CONSTRAINT \`fk_codemode_event_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
}

export default migration
