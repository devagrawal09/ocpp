import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { fileURLToPath } from "url"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@ocpp/core/database/drizzle"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@ocpp/core/database/migration"
import { migrations } from "@ocpp/core/database/migration.gen"
import workspaceNameMigration from "@ocpp/core/database/migration/20260410174513_workspace-name"
import { Database } from "@ocpp/core/database/database"
import { tmpdir } from "./fixture/tmpdir"
import type { SqlClient } from "effect/sql/SqlClient"
import legacyCredentialsMigration from "@ocpp/core/database/migration/20260805200742_import_legacy_credentials"
import credentialSecretMigration from "@ocpp/core/database/migration/20261009205324_credential_secret"
import cacheMigration from "@ocpp/core/database/migration/20261009220914_cache"
import jobBackgroundMigration from "@ocpp/core/database/migration/20261009210354_job_background"
import worktreeMigration from "@ocpp/core/database/migration/20260812213948_worktree"
import previousV2Migration from "@ocpp/core/database/migration/20260804233008_loose_psylocke"
import workspaceMigration from "@ocpp/core/database/migration/20260808023530_workspace_domain"
import executionClaimsMigration from "@ocpp/core/database/migration/20260811161259_execution_claim_attempts"
import sessionInboxMigration from "@ocpp/core/database/migration/20260812181746_session_inbox"
import sessionViewedStateMigration from "@ocpp/core/database/migration/20260819222447_session_viewed_state"
import toolListsMigration from "@ocpp/core/database/migration/20260928161342_tool_lists"
import notebookCheckpointMigration from "@ocpp/core/database/migration/20260930223025_notebook_checkpoint"
import { Global } from "@ocpp/util/global"

const run = <A, E>(
  effect: Effect.Effect<A, E, SqlClient | Global.Service>,
  global = Global.make({ data: path.join(process.cwd(), ".test-data") }),
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(Global.Service, global),
      Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })),
      Effect.scoped,
    ),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

describe("DatabaseMigration", () => {
  test("defaults missing workspace names while preserving legacy workspace data", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`
          CREATE TABLE workspace (
            id text PRIMARY KEY,
            type text NOT NULL,
            branch text,
            directory text,
            extra text,
            project_id text NOT NULL
          )
        `)
        yield* db.run(sql`
          INSERT INTO workspace (id, type, branch, directory, extra, project_id)
          VALUES ('wrk_legacy', 'remote', 'main', '/repo', '{}', 'proj_legacy')
        `)

        yield* DatabaseMigration.applyOnly(db, [workspaceNameMigration])

        expect(yield* db.get(sql`SELECT id, name, branch, directory, extra FROM workspace`)).toEqual({
          id: "wrk_legacy",
          name: "",
          branch: "main",
          directory: "/repo",
          extra: "{}",
        })
      }),
    )
  })

  test("imports unnamed legacy Drizzle journal entries by their actual migration timestamps", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE __drizzle_migrations (id integer PRIMARY KEY, hash text, created_at integer)`)
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at)
          VALUES ('', ${Date.UTC(2026, 3, 10, 17, 45, 13)})
        `)

        yield* DatabaseMigration.applyOnly(db, [workspaceNameMigration])

        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: "20260410174513_workspace-name" }])
      }),
    )
  })

  test("rejects unknown legacy Drizzle journal timestamps instead of guessing completed migrations", async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* db.run(sql`CREATE TABLE __drizzle_migrations (id integer PRIMARY KEY, hash text, created_at integer)`)
          yield* db.run(sql`INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('', 1234567890000)`)
          yield* DatabaseMigration.applyOnly(db, [workspaceNameMigration])
        }),
      ),
    ).rejects.toThrow("does not match any known migration")
  })

  test("serializes concurrent embedded initialization for one database path", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "embedded.sqlite")

    await Effect.runPromise(
      Effect.all(
        [Database.layer({ path: filename }), Database.layer({ path: filename })].map((layer) =>
          Effect.scoped(Layer.build(layer)),
        ),
        { concurrency: "unbounded" },
      ).pipe(Effect.provideService(Global.Service, Global.make({ data: tmp.path }))),
    )
  })

  if (process.platform === "linux") {
    test("declared schema has no ungenerated migrations", async () => {
      const result = await $`bun ${fileURLToPath(new URL("../script/migration.ts", import.meta.url))} --check`
        .quiet()
        .nothrow()
      expect(result.exitCode, result.stderr.toString()).toBe(0)
      expect(result.stdout.toString()).toContain("No schema changes, nothing to migrate")
    }, 30_000)
  }

  test("bootstraps the current schema and records the migration registry", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)

        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'`)).toEqual(
          {
            name: "session_v2",
          },
        )
        // Legacy tables are gone from the current schema.
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_pending'`),
        ).toBeUndefined()
        expect(yield* db.get(sql`SELECT count(*) AS count FROM migration`)).toEqual({ count: migrations.length })
      }),
    )
  })

  test("adds nullable attention state to existing sessions", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session_v2 (id text PRIMARY KEY, title text)`)
        yield* db.run(sql`INSERT INTO session_v2 (id, title) VALUES ('ses_existing', 'Existing')`)

        yield* DatabaseMigration.applyOnly(db, [sessionViewedStateMigration])
        yield* DatabaseMigration.applyOnly(db, [sessionViewedStateMigration])

        expect(yield* db.get(sql`SELECT id, title, time_idle, time_viewed, idle_outcome FROM session_v2`)).toEqual({
          id: "ses_existing",
          title: "Existing",
          time_idle: null,
          time_viewed: null,
          idle_outcome: null,
        })
        expect(yield* db.get(sql`SELECT count(*) AS count FROM migration`)).toEqual({ count: 1 })
      }),
    )
  })

  test("drops saved approvals and adds tool lists to sessions and executions", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session_v2 (id text PRIMARY KEY, title text)`)
        yield* db.run(sql`CREATE TABLE codemode_execution (id text PRIMARY KEY)`)
        yield* db.run(sql`
          CREATE TABLE permission (
            project_id text NOT NULL,
            action text NOT NULL,
            resource text NOT NULL,
            time_created integer NOT NULL
          )
        `)
        yield* db.run(
          sql`CREATE UNIQUE INDEX permission_project_action_resource_idx ON permission (project_id, action, resource)`,
        )
        yield* db.run(sql`INSERT INTO permission VALUES ('proj_saved', 'shell', 'git status *', 1)`)
        yield* db.run(sql`INSERT INTO session_v2 (id, title) VALUES ('ses_existing', 'Existing')`)
        yield* db.run(sql`INSERT INTO codemode_execution (id) VALUES ('exe_existing')`)

        yield* DatabaseMigration.applyOnly(db, [toolListsMigration])

        expect(yield* db.all(sql`SELECT name FROM sqlite_master WHERE name LIKE 'permission%' ORDER BY name`)).toEqual(
          [],
        )
        expect(yield* db.get(sql`SELECT id, title, tools FROM session_v2`)).toEqual({
          id: "ses_existing",
          title: "Existing",
          tools: null,
        })
        expect(yield* db.get(sql`SELECT id, tools FROM codemode_execution`)).toEqual({
          id: "exe_existing",
          tools: null,
        })
      }),
    )
  })

  test("checkpoints existing notebooks into instruction baselines and linked vendor sessions", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE instruction_state (session_id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE session_external (session_id text PRIMARY KEY, vendor_session_id text)`)
        yield* db.run(sql`CREATE TABLE codemode_binding (session_id text NOT NULL, name text NOT NULL)`)
        yield* db.run(sql`INSERT INTO instruction_state (session_id) VALUES ('ses_saved'), ('ses_empty')`)
        yield* db.run(
          sql`INSERT INTO session_external (session_id, vendor_session_id) VALUES ('ses_saved', 'vendor'), ('ses_unlinked', NULL)`,
        )
        yield* db.run(
          sql`INSERT INTO codemode_binding (session_id, name) VALUES ('ses_saved', 'total'), ('ses_unlinked', 'draft')`,
        )

        yield* DatabaseMigration.applyOnly(db, [notebookCheckpointMigration])

        expect(yield* db.all(sql`SELECT session_id, notebook FROM instruction_state ORDER BY session_id`)).toEqual([
          { session_id: "ses_empty", notebook: "[]" },
          { session_id: "ses_saved", notebook: '["total"]' },
        ])
        expect(yield* db.all(sql`SELECT session_id, notebook FROM session_external ORDER BY session_id`)).toEqual([
          { session_id: "ses_saved", notebook: '["total"]' },
          { session_id: "ses_unlinked", notebook: null },
        ])
      }),
    )
  })

  test("rejects a non-empty database without a session table", async () => {
    await expect(
      run(
        Effect.gen(function* () {
          const db = yield* makeDb
          yield* db.run(sql`CREATE TABLE unrelated (id text PRIMARY KEY)`)
          yield* DatabaseMigration.apply(db)
        }),
      ),
    ).rejects.toThrow("Database is not empty and has no session table")
  })

  test("bootstraps alongside underscore-prefixed embedder tables", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE _embedder_state (id text PRIMARY KEY)`)
        yield* DatabaseMigration.apply(db)
        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session_v2'`)).toEqual(
          { name: "session_v2" },
        )
      }),
    )
  })

  test("applies generic migrations once and records their order", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        const input = [
          {
            id: "first",
            up: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) =>
              tx.run(sql`CREATE TABLE applied (id text PRIMARY KEY)`),
          },
          {
            id: "second",
            up: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) =>
              tx.run(sql`INSERT INTO applied (id) VALUES ('second')`),
          },
        ]

        yield* DatabaseMigration.applyOnly(db, input)
        yield* DatabaseMigration.applyOnly(db, input)

        expect(yield* db.all(sql`SELECT id FROM applied`)).toEqual([{ id: "second" }])
        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY time_completed, id`)).toEqual([
          { id: "first" },
          { id: "second" },
        ])
      }),
    )
  })

  test("preserves previous V2 state through the current migration lineage", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE migration (id text PRIMARY KEY, time_completed integer NOT NULL)`)
        yield* db.run(sql`
          INSERT INTO migration (id, time_completed)
          VALUES ('20260730195856_optional_session_title', 1)
        `)
        yield* db.run(sql`CREATE TABLE project (id text PRIMARY KEY)`)
        yield* db.run(sql`
          CREATE TABLE project_directory (
            project_id text NOT NULL,
            directory text NOT NULL,
            type text,
            strategy text,
            time_created integer NOT NULL,
            PRIMARY KEY (project_id, directory)
          )
        `)
        yield* db.run(sql`
          CREATE TABLE workspace (
            id text PRIMARY KEY,
            type text NOT NULL,
            name text NOT NULL,
            project_id text NOT NULL,
            time_used integer NOT NULL
          )
        `)
        yield* db.run(sql`
          CREATE TABLE session (
            id text PRIMARY KEY,
            project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
            workspace_id text,
            parent_id text,
            time_suspended integer
          )
        `)
        yield* db.run(sql`CREATE INDEX session_project_idx ON session (project_id)`)
        yield* db.run(sql`CREATE INDEX session_workspace_idx ON session (workspace_id)`)
        yield* db.run(sql`CREATE INDEX session_parent_idx ON session (parent_id)`)
        yield* db.run(
          sql`CREATE INDEX session_time_suspended_idx ON session (time_suspended) WHERE "session"."time_suspended" IS NOT NULL`,
        )
        yield* db.run(sql`
          CREATE TABLE session_message (
            id text PRIMARY KEY,
            session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE,
            data text NOT NULL
          )
        `)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL)`)
        yield* db.run(sql`
          CREATE TABLE session_pending (
            id text PRIMARY KEY,
            session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE
          )
        `)
        yield* db.run(sql`CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL)`)
        yield* db.run(sql`
          CREATE TABLE event (
            id text PRIMARY KEY,
            aggregate_id text NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
            seq integer NOT NULL,
            created integer NOT NULL,
            type text NOT NULL,
            data text NOT NULL
          )
        `)
        yield* db.run(sql`CREATE TABLE data_migration (name text PRIMARY KEY)`)
        yield* db.run(sql`INSERT INTO project VALUES ('project')`)
        yield* db.run(sql`INSERT INTO project_directory VALUES ('project', '/repo', 'main', NULL, 1)`)
        yield* db.run(sql`INSERT INTO session VALUES ('session', 'project', NULL, NULL, NULL)`)
        yield* db.run(sql`INSERT INTO session_message VALUES ('message', 'session', '{"text":"preserved"}')`)
        yield* db.run(sql`INSERT INTO session_pending VALUES ('pending', 'session')`)
        yield* db.run(sql`INSERT INTO event_sequence VALUES ('session', 41)`)
        yield* db.run(sql`INSERT INTO event VALUES ('event', 'session', 41, 1, 'session.text.ended.1', '{}')`)

        yield* DatabaseMigration.applyOnly(db, [
          previousV2Migration,
          workspaceMigration,
          executionClaimsMigration,
          sessionInboxMigration,
          worktreeMigration,
        ])

        expect(yield* db.get(sql`SELECT id, resume_attempts FROM session_v2`)).toEqual({
          id: "session",
          resume_attempts: 0,
        })
        expect(yield* db.get(sql`SELECT id, data FROM session_message`)).toEqual({
          id: "message",
          data: '{"text":"preserved"}',
        })
        expect(yield* db.get(sql`SELECT id FROM session_pending`)).toEqual({ id: "pending" })
        expect(yield* db.get(sql`SELECT seq FROM event_sequence`)).toEqual({ seq: 41 })
        expect(yield* db.get(sql`SELECT id, seq FROM event`)).toEqual({ id: "event", seq: 41 })
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'`),
        ).toBeUndefined()
        expect(yield* db.get(sql`SELECT directory FROM worktree`)).toEqual({ directory: "/repo" })
        expect(yield* db.all<{ table: string }>(sql`PRAGMA foreign_key_list(session_message)`)).toContainEqual(
          expect.objectContaining({ table: "session_v2" }),
        )
        expect(yield* db.all<{ table: string }>(sql`PRAGMA foreign_key_list(session_pending)`)).toContainEqual(
          expect.objectContaining({ table: "session_v2" }),
        )
      }),
    )
  })

  test("rejects previous V2 databases with V1-only session history", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE migration (id text PRIMARY KEY, time_completed integer NOT NULL)`)
        yield* db.run(sql`
          INSERT INTO migration (id, time_completed)
          VALUES ('20260730195856_optional_session_title', 1)
        `)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        yield* db.run(sql`CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL)`)
        yield* db.run(sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL)`)
        yield* db.run(sql`INSERT INTO session VALUES ('session')`)
        yield* db.run(sql`INSERT INTO message VALUES ('message', 'session')`)

        expect((yield* Effect.exit(DatabaseMigration.applyOnly(db, [previousV2Migration])))._tag).toBe("Failure")
        expect(yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'session'`)).toEqual({
          name: "session",
        })
        expect(yield* db.get(sql`SELECT id FROM migration WHERE id = ${previousV2Migration.id}`)).toBeUndefined()
      }),
    )
  })

  test("copies project directories into worktrees without removing the old table", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE project (id text PRIMARY KEY)`)
        yield* db.run(
          sql`CREATE TABLE project_directory (project_id text NOT NULL, directory text NOT NULL, type text, strategy text, time_created integer NOT NULL, PRIMARY KEY (project_id, directory))`,
        )
        yield* db.run(
          sql`INSERT INTO project_directory (project_id, directory, type, strategy, time_created) VALUES ('project', '/root', 'main', NULL, 1), ('project', '/legacy', 'git_worktree', NULL, 2), ('project', '/strategy', NULL, 'git_worktree', 3), ('project', '/custom', NULL, 'acme/snapshot', 4)`,
        )

        yield* DatabaseMigration.applyOnly(db, [worktreeMigration])

        expect(yield* db.all(sql`SELECT directory, strategy FROM worktree ORDER BY directory`)).toEqual([
          { directory: "/custom", strategy: "acme/snapshot" },
          { directory: "/legacy", strategy: "git" },
          { directory: "/root", strategy: null },
          { directory: "/strategy", strategy: "git" },
        ])
        expect(yield* db.get(sql`SELECT count(*) AS count FROM project_directory`)).toEqual({ count: 4 })
      }),
    )
  })

  test("imports legacy JSON credentials without changing the source file or existing credentials", async () => {
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "auth.json")
    const content = JSON.stringify({
      openai: { type: "oauth", refresh: "refresh", access: "access", expires: 123, accountId: "account" },
      anthropic: { type: "api", key: "legacy-key", metadata: { region: "us" } },
      google: { type: "api", key: "google-key", metadata: { region: "us" } },
      "github-copilot": { type: "oauth", refresh: "refresh", access: "access", expires: 123 },
      "custom-provider": { type: "api", key: "custom-key" },
      "https://example.com/": { type: "wellknown", key: "TOKEN", token: "wellknown-key" },
      invalid: { type: "unknown" },
    })
    await Bun.write(source, content)

    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        // The import ran against credentials that kept their secrets inline, which a later migration
        // moved into their own table: apply the migrations in order around it.
        yield* DatabaseMigration.applyOnly(
          db,
          migrations.filter(
            (migration) =>
              migration.id < credentialSecretMigration.id && migration.id !== legacyCredentialsMigration.id,
          ),
        )
        const now = Date.now()
        yield* db.run(sql`
          INSERT INTO credential (id, integration_id, label, value, time_created, time_updated)
          VALUES ('existing', 'anthropic', 'Existing', ${JSON.stringify({ type: "key", key: "current-key" })}, ${now}, ${now})
        `)

        yield* db.run(sql`DELETE FROM migration WHERE id = ${legacyCredentialsMigration.id}`)
        yield* DatabaseMigration.applyOnly(db, [legacyCredentialsMigration])
        yield* DatabaseMigration.applyOnly(db, [legacyCredentialsMigration])
        yield* DatabaseMigration.applyOnly(db, migrations)

        expect(
          yield* db.all(
            sql`SELECT integration_id, label, value FROM credential JOIN credential_secret ON credential_id = id ORDER BY integration_id`,
          ),
        ).toEqual([
          {
            integration_id: "anthropic",
            label: "Existing",
            value: JSON.stringify({ type: "key", key: "current-key" }),
          },
          {
            integration_id: "custom-provider",
            label: "API key",
            value: JSON.stringify({ type: "key", key: "custom-key" }),
          },
          {
            integration_id: "github-copilot",
            label: "OAuth",
            value: JSON.stringify({
              type: "oauth",
              methodID: "device",
              refresh: "refresh",
              access: "access",
              expires: 123,
            }),
          },
          {
            integration_id: "google",
            label: "API key",
            value: JSON.stringify({ type: "key", key: "google-key", metadata: { region: "us" } }),
          },
          {
            integration_id: "https://example.com",
            label: "API key",
            value: JSON.stringify({ type: "key", key: "wellknown-key" }),
          },
          {
            integration_id: "openai",
            label: "OAuth",
            value: JSON.stringify({
              type: "oauth",
              methodID: "chatgpt-browser",
              refresh: "refresh",
              access: "access",
              expires: 123,
              metadata: { accountID: "account" },
            }),
          },
        ])
        expect(yield* db.get(sql`SELECT value FROM kv WHERE key = 'wellknown:sources'`)).toEqual({
          value: JSON.stringify(["https://example.com"]),
        })
      }),
      Global.make({ data: tmp.path }),
    )

    expect(await Bun.file(source).text()).toBe(content)
  })

  test("moves background job markers out of the key-value store", async () => {
    await using tmp = await tmpdir()
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.applyOnly(
          db,
          migrations.filter(
            (migration) => migration.id < jobBackgroundMigration.id && migration.id !== legacyCredentialsMigration.id,
          ),
        )
        const now = Date.now()
        const recovery = { kind: "shell", sessionID: "ses_1", shellID: "sh_1", command: "sleep 1" }
        const marker = { id: "job_1", notificationID: "msg_1", recovery, status: "running", terminal: true }
        yield* db.run(sql`
          INSERT INTO kv (key, value, time_created, time_updated)
          VALUES ('job.background/msg_1', ${JSON.stringify(marker)}, ${now}, ${now}),
            ('models.dev', ${JSON.stringify({ body: "{}" })}, ${now}, ${now})
        `)
        yield* DatabaseMigration.applyOnly(db, migrations)

        const rows = yield* db.all<Record<string, unknown>>(sql`SELECT * FROM job_background`)
        const markers: unknown = rows.map((row) => ({ ...row, recovery: JSON.parse(String(row.recovery)) }))
        expect(markers).toEqual([
          {
            notification_id: "msg_1",
            job_id: "job_1",
            recovery,
            status: "running",
            terminal: 1,
            output: null,
            error: null,
          },
        ])
        expect(yield* db.all(sql`SELECT key FROM kv`)).toEqual([{ key: "models.dev" }])
      }),
      Global.make({ data: tmp.path }),
    )
  })

  test("moves cached external resources out of the key-value store", async () => {
    await using tmp = await tmpdir()
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.applyOnly(
          db,
          migrations.filter(
            (migration) => migration.id < cacheMigration.id && migration.id !== legacyCredentialsMigration.id,
          ),
        )
        const now = Date.now()
        yield* db.run(sql`
          INSERT INTO kv (key, value, time_created, time_updated)
          VALUES ('models-dev:catalog', ${JSON.stringify({ updatedAt: 1, body: "{}" })}, ${now}, ${now}),
            ('repository-cache:/repo', ${JSON.stringify({ attemptedAt: 1 })}, ${now}, ${now}),
            ('websearch:provider', ${JSON.stringify("exa")}, ${now}, ${now})
        `)
        yield* DatabaseMigration.applyOnly(db, migrations)

        expect(yield* db.all(sql`SELECT key FROM cache ORDER BY key`)).toEqual([
          { key: "models-dev:catalog" },
          { key: "repository-cache:/repo" },
        ])
        expect(yield* db.all(sql`SELECT key FROM kv`)).toEqual([{ key: "websearch:provider" }])
      }),
      Global.make({ data: tmp.path }),
    )
  })

  test("skips legacy credential import when the source file is absent", async () => {
    await using tmp = await tmpdir()

    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* DatabaseMigration.apply(db)
        yield* db.run(sql`DELETE FROM migration WHERE id = ${legacyCredentialsMigration.id}`)
        yield* DatabaseMigration.applyOnly(db, [legacyCredentialsMigration])

        expect(yield* db.all(sql`SELECT id FROM credential`)).toEqual([])
      }),
      Global.make({ data: tmp.path }),
    )
  })

  test("rolls back a failed migration without recording it", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY)`)
        const migration = {
          id: "failing",
          up: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) =>
            Effect.gen(function* () {
              yield* tx.run(sql`CREATE TABLE rolled_back (id text PRIMARY KEY)`)
              yield* Effect.fail(new Error("stop"))
            }),
        }

        expect((yield* Effect.exit(DatabaseMigration.applyOnly(db, [migration])))._tag).toBe("Failure")
        expect(
          yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'rolled_back'`),
        ).toBeUndefined()
        expect(yield* db.get(sql`SELECT id FROM migration WHERE id = 'failing'`)).toBeUndefined()
      }),
    )
  })

  test("suspends foreign keys outside migrations that rebuild referenced tables", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(sql`PRAGMA foreign_keys = ON`)
        yield* db.run(sql`CREATE TABLE session (id text PRIMARY KEY, title text NOT NULL)`)
        yield* db.run(
          sql`CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL REFERENCES session(id) ON DELETE CASCADE)`,
        )
        yield* db.run(sql`INSERT INTO session VALUES ('session', 'title')`)
        yield* db.run(sql`INSERT INTO message VALUES ('message', 'session')`)

        yield* DatabaseMigration.applyOnly(db, [
          {
            id: "rebuild",
            foreignKeys: false,
            up: (tx) =>
              Effect.gen(function* () {
                yield* tx.run(sql`CREATE TABLE next_session (id text PRIMARY KEY, title text)`)
                yield* tx.run(sql`INSERT INTO next_session SELECT * FROM session`)
                yield* tx.run(sql`DROP TABLE session`)
                yield* tx.run(sql`ALTER TABLE next_session RENAME TO session`)
              }),
          },
        ])

        expect(yield* db.get(sql`SELECT id FROM message`)).toEqual({ id: "message" })
        expect(yield* db.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`)).toEqual({ foreign_keys: 1 })
      }),
    )
  })

  test("imports an existing Drizzle migration journal once", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* makeDb
        yield* db.run(
          sql`CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY, hash text NOT NULL, created_at numeric, name text, applied_at TEXT)`,
        )
        yield* db.run(sql`
          INSERT INTO __drizzle_migrations (hash, created_at, name, applied_at)
          VALUES ('hash', 1, 'legacy', ${new Date().toISOString()})
        `)

        yield* DatabaseMigration.applyOnly(db, [])
        expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: "legacy" }])

        yield* db.run(sql`INSERT INTO migration (id, time_completed) VALUES ('existing', 1)`)
        yield* db.run(sql`UPDATE __drizzle_migrations SET name = 'ignored'`)
        yield* DatabaseMigration.applyOnly(db, [])
        expect(yield* db.all(sql`SELECT id FROM migration ORDER BY id`)).toEqual([{ id: "existing" }, { id: "legacy" }])
      }),
    )
  })
})
