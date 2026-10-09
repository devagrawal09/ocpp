import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261009210354_job_background",
  up(tx) {
    return Effect.gen(function* () {
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
      yield* tx.run(`CREATE INDEX \`job_background_job_idx\` ON \`job_background\` (\`job_id\`);`)
      // The markers the job registry kept in the key-value store move here.
      yield* tx.run(`
        INSERT INTO \`job_background\` (\`notification_id\`, \`job_id\`, \`recovery\`, \`status\`, \`terminal\`, \`output\`, \`error\`)
        SELECT json_extract(\`value\`, '$.notificationID'), json_extract(\`value\`, '$.id'),
          json_extract(\`value\`, '$.recovery'), json_extract(\`value\`, '$.status'),
          coalesce(json_extract(\`value\`, '$.terminal'), 0), json_extract(\`value\`, '$.output'),
          json_extract(\`value\`, '$.error')
        FROM \`kv\` WHERE \`key\` LIKE 'job.background/%';
      `)
      yield* tx.run(`DELETE FROM \`kv\` WHERE \`key\` LIKE 'job.background/%';`)
    })
  },
}

export default migration
