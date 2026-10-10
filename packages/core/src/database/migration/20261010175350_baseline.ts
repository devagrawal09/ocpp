import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261010175350_baseline",
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
      yield* tx.run(`
        CREATE TABLE \`cache\` (
          \`key\` text PRIMARY KEY,
          \`value\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
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
          \`input\` text,
          \`tools\` text,
          \`saved\` text,
          \`error\` text,
          \`resumes\` integer DEFAULT 0 NOT NULL,
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
          \`omitted\` integer DEFAULT false NOT NULL,
          \`impure\` text,
          \`progress\` text,
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
      yield* tx.run(`
        CREATE TABLE \`credential_key\` (
          \`credential_id\` text PRIMARY KEY,
          \`key\` text NOT NULL,
          CONSTRAINT \`fk_credential_key_credential_id_credential_id_fk\` FOREIGN KEY (\`credential_id\`) REFERENCES \`credential\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`credential_secret\` (
          \`credential_id\` text PRIMARY KEY,
          \`value\` text NOT NULL,
          CONSTRAINT \`fk_credential_secret_credential_id_credential_id_fk\` FOREIGN KEY (\`credential_id\`) REFERENCES \`credential\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text NOT NULL,
          \`label\` text NOT NULL,
          \`active\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`created\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`log_order\` integer NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_event_log_order_specter_event_order_fk\` FOREIGN KEY (\`log_order\`) REFERENCES \`specter_event\`(\`order\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_external\` (
          \`session_id\` text PRIMARY KEY,
          \`provider\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`vendor_session_id\` text,
          \`checkpoint\` text,
          \`history_hash\` text,
          \`notebook\` text,
          \`status\` text NOT NULL,
          \`harness\` text,
          CONSTRAINT \`fk_session_external_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`job_background\` (
          \`notification_id\` text PRIMARY KEY,
          \`job_id\` text NOT NULL,
          \`recovery\` text NOT NULL,
          \`status\` text NOT NULL,
          \`terminal\` integer DEFAULT false NOT NULL,
          \`output\` text,
          \`error\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`kv\` (
          \`key\` text PRIMARY KEY,
          \`value\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`instruction_blob\` (
          \`hash\` text PRIMARY KEY,
          \`value\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`instruction_entry\` (
          \`session_id\` text NOT NULL,
          \`key\` text NOT NULL,
          \`value\` text,
          \`removed\` integer DEFAULT false NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`instruction_entry_pk\` PRIMARY KEY(\`session_id\`, \`key\`),
          CONSTRAINT \`fk_instruction_entry_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`instruction_state\` (
          \`session_id\` text PRIMARY KEY,
          \`epoch_start\` integer NOT NULL,
          \`through_seq\` integer NOT NULL,
          \`initial_values\` text NOT NULL,
          \`current_values\` text NOT NULL,
          \`notebook\` text DEFAULT '[]' NOT NULL,
          CONSTRAINT \`fk_instruction_state_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_inbox\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`payload\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`enqueued_seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_inbox_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_v2_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session_v2\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_v2\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`fork_session_id\` text,
          \`fork_boundary\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text,
          \`version\` text NOT NULL,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`agent\` text,
          \`tools\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_idle\` integer,
          \`time_viewed\` integer,
          \`idle_outcome\` text,
          \`idle_error_type\` text,
          \`idle_error_message\` text,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          CONSTRAINT \`fk_session_v2_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
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
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`provider\` text NOT NULL,
          \`binding\` text,
          \`created_at\` integer NOT NULL,
          \`last_used_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`worktree\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`worktree_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_worktree_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`codemode_binding_session_seq_idx\` ON \`codemode_binding\` (\`session_id\`,\`message_seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`codemode_execution_session_created_idx\` ON \`codemode_execution\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`codemode_reservation_execution_idx\` ON \`codemode_reservation\` (\`execution_id\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`job_background_job_idx\` ON \`job_background\` (\`job_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_inbox_session_delivery_seq_idx\` ON \`session_inbox\` (\`session_id\`,\`delivery\`,\`enqueued_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_inbox_session_enqueued_seq_idx\` ON \`session_inbox\` (\`session_id\`,\`enqueued_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`session_v2_project_idx\` ON \`session_v2\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_v2_workspace_idx\` ON \`session_v2\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_v2_parent_idx\` ON \`session_v2\` (\`parent_id\`);`)
      yield* tx.run(`CREATE INDEX \`specter_event_type_order_idx\` ON \`specter_event\` (\`type\`,\`order\`);`)
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
