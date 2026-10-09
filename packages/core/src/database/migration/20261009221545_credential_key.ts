import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { CredentialSeal } from "../../credential/seal.js"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261009221545_credential_key",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`credential_key\` (
          \`credential_id\` text PRIMARY KEY,
          \`key\` text NOT NULL,
          CONSTRAINT \`fk_credential_key_credential_id_credential_id_fk\` FOREIGN KEY (\`credential_id\`) REFERENCES \`credential\`(\`id\`) ON DELETE CASCADE
        );
      `)
      // Every stored secret is sealed under a new key of its own credential, as a fact carries it.
      const secrets = yield* tx.all<{ credential_id: string; value: string }>(
        sql`SELECT credential_id, value FROM credential_secret`,
      )
      for (const secret of secrets) {
        const key = CredentialSeal.generateKey()
        const sealed = yield* CredentialSeal.seal(key, JSON.parse(secret.value))
        yield* tx.run(sql`INSERT INTO credential_key (credential_id, key) VALUES (${secret.credential_id}, ${key})`)
        yield* tx.run(
          sql`UPDATE credential_secret SET value = ${JSON.stringify(sealed)} WHERE credential_id = ${secret.credential_id}`,
        )
      }
    })
  },
}

export default migration
