import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261009222738_event_index",
  up(tx) {
    return Effect.gen(function* () {
      // Events stored before Specter's log held them are archived in it under their versioned OC++ type,
      // which the runtime does not read: one commit per aggregate, in sequence order. An event the log
      // already holds keeps its fact.
      const before =
        (yield* tx.get<{ order: number | null }>(sql`SELECT max("order") AS "order" FROM specter_event`))?.order ?? 0
      yield* tx.run(sql`
        INSERT OR IGNORE INTO specter_event (id, type, payload, recorded_at)
        SELECT id, type, data, strftime('%Y-%m-%dT%H:%M:%fZ', created / 1000.0, 'unixepoch')
        FROM event ORDER BY aggregate_id, seq
      `)
      yield* tx.run(sql`
        INSERT INTO specter_commit (version, idempotency_key, fingerprint, first_order, committed_at)
        SELECT max(specter_event."order"), 'archive:' || event.aggregate_id, NULL, min(specter_event."order"),
          strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        FROM specter_event JOIN event ON event.id = specter_event.id
        WHERE specter_event."order" > ${before}
        GROUP BY event.aggregate_id
      `)

      // The event table becomes their index by aggregate sequence: the log holds the events.
      yield* tx.run(`
        CREATE TABLE \`event_index\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`created\` integer DEFAULT 0 NOT NULL,
          \`type\` text NOT NULL,
          \`log_order\` integer NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_event_log_order_specter_event_order_fk\` FOREIGN KEY (\`log_order\`) REFERENCES \`specter_event\`(\`order\`)
        );
      `)
      yield* tx.run(`
        INSERT INTO \`event_index\` (\`id\`, \`aggregate_id\`, \`seq\`, \`created\`, \`type\`, \`log_order\`)
        SELECT event.id, event.aggregate_id, event.seq, event.created, event.type, specter_event."order"
        FROM \`event\` AS event JOIN \`specter_event\` AS specter_event ON specter_event.id = event.id;
      `)
      yield* tx.run(`DROP TABLE \`event\`;`)
      yield* tx.run(`ALTER TABLE \`event_index\` RENAME TO \`event\`;`)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      // Replay owners went with replaying events from other servers.
      yield* tx.run(`ALTER TABLE \`event_sequence\` DROP COLUMN \`owner_id\`;`)
    })
  },
}

export default migration
