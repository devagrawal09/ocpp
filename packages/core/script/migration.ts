#!/usr/bin/env bun

import { Database } from "bun:sqlite"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { parseArgs } from "util"

const root = path.resolve(import.meta.dirname, "../../..")
const snapshot = path.join(root, "packages/core/schema.json")
const tsDir = path.join(root, "packages/core/src/database/migration")
const registry = path.join(root, "packages/core/src/database/migration.gen.ts")
const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    check: { type: "boolean" },
    name: { type: "string" },
    // Drizzle cannot tell a rename from a create; forward its resolution hints when it asks.
    hints: { type: "string" },
  },
})

if (args.values.check) {
  await check()
  process.exit(0)
}

await generate()

async function generate() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ocpp-core-migration-"))
  const incremental = path.join(temporary, "incremental")
  try {
    await fs.mkdir(incremental)
    // Without a snapshot the migration creates the whole declared schema: a new baseline.
    if (await Bun.file(snapshot).exists()) {
      await fs.mkdir(path.join(incremental, "baseline"))
      await fs.copyFile(snapshot, path.join(incremental, "baseline/snapshot.json"))
    }
    await drizzle(temporary, incremental, args.values.name, args.values.hints)

    const generated = await generatedMigrations(incremental)
    if (generated.length > 1) throw new Error(`Expected one generated migration, found ${generated.length}.`)
    const name = generated[0]
    if (name) {
      const target = path.join(tsDir, `${name}.ts`)
      if (await Bun.file(target).exists()) throw new Error(`Database migration already exists: ${name}`)
      await Bun.write(
        target,
        await formatTypescript(
          renderMigration(name, await Bun.file(path.join(incremental, name, "migration.sql")).text()),
        ),
      )
      await Bun.write(snapshot, await formatJson(await Bun.file(path.join(incremental, name, "snapshot.json")).text()))
    }

    await Bun.write(registry, await formatTypescript(renderRegistry(await typescriptMigrations())))
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

async function check() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ocpp-core-migration-check-"))
  const incremental = path.join(temporary, "incremental")
  const full = path.join(temporary, "full")
  try {
    await fs.mkdir(incremental)
    await fs.mkdir(path.join(incremental, "baseline"))
    await fs.copyFile(snapshot, path.join(incremental, "baseline/snapshot.json"))
    await drizzle(temporary, incremental)
    if ((await generatedMigrations(incremental)).length > 0) {
      throw new Error(
        "Core schema has ungenerated database migrations. Run `bun script/migration.ts` from packages/core.",
      )
    }

    const migrations = await typescriptMigrations()
    if ((await Bun.file(registry).text()) !== (await formatTypescript(renderRegistry(migrations)))) {
      throw new Error("Database migration registry is stale. Run `bun script/migration.ts` from packages/core.")
    }

    // A database the migrations build has the schema the tables declare.
    await fs.mkdir(full)
    await drizzle(temporary, full, "schema")
    const declared = path.join(temporary, "declared.sqlite")
    const database = new Database(declared)
    for (const statement of statements(await generatedSql(full))) database.run(statement)
    database.close()
    const migrated = path.join(temporary, "migrated.sqlite")
    await migrate(migrated, temporary)
    const expected = new Set(structure(declared))
    const actual = new Set(structure(migrated))
    const differences = [
      ...[...expected].filter((entry) => !actual.has(entry)).map((entry) => `  declared, not migrated: ${entry}`),
      ...[...actual].filter((entry) => !expected.has(entry)).map((entry) => `  migrated, not declared: ${entry}`),
    ]
    if (differences.length > 0)
      throw new Error(`The migrations do not build the declared schema:\n${differences.join("\n")}`)
  } finally {
    await fs.rm(temporary, { recursive: true, force: true })
  }
}

async function drizzle(temporary: string, output: string, name?: string, hints?: string) {
  const config = path.join(temporary, `${path.basename(output)}.config.ts`)
  await Bun.write(
    config,
    `import config from ${JSON.stringify(pathToFileURL(path.join(root, "packages/core/drizzle.config.ts")).href)}

export default { ...config, out: ${JSON.stringify(output)} }
`,
  )
  const child = Bun.spawn(
    [
      "bun",
      "drizzle-kit",
      "generate",
      "--config",
      config,
      ...(name ? ["--name", name] : []),
      ...(hints ? ["--hints", hints] : []),
    ],
    {
      cwd: path.join(root, "packages/core"),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  )
  const exit = await child.exited
  if (exit !== 0) throw new Error(`Drizzle generation failed with exit code ${exit}.`)
}

async function generatedMigrations(directory: string) {
  return (await Array.fromAsync(new Bun.Glob("*/migration.sql").scan({ cwd: directory })))
    .map((file) => file.split("/")[0])
    .filter((name): name is string => name !== undefined)
    .sort()
}

async function generatedSql(directory: string) {
  const generated = await generatedMigrations(directory)
  if (generated.length !== 1) throw new Error(`Expected one full schema migration, found ${generated.length}.`)
  return Bun.file(path.join(directory, generated[0]!, "migration.sql")).text()
}

async function typescriptMigrations() {
  return (await Array.fromAsync(new Bun.Glob("*.ts").scan({ cwd: tsDir })))
    .map((file) => path.basename(file, ".ts"))
    .sort()
}

function renderMigration(name: string, sql: string) {
  return `import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: ${JSON.stringify(name)},
  up(tx) {
    return Effect.gen(function* () {
${renderStatements(sql)}
    })
  },
}

export default migration
`
}

function statements(sql: string) {
  return sql
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}

function renderStatements(sql: string) {
  return statements(sql).map(renderRun).join("\n")
}

// Builds a database with OC++'s own migrator, as a boot does.
async function migrate(file: string, data: string) {
  const { Effect } = await import("effect")
  const { SqliteClient } = await import("@effect/sql-sqlite-bun")
  const { Global } = await import("@ocpp/util/global")
  const { EffectDrizzleSqlite } = await import("../src/database/drizzle.ts")
  const { DatabaseMigration } = await import("../src/database/migration.ts")
  await Effect.runPromise(
    EffectDrizzleSqlite.makeWithDefaults().pipe(
      Effect.flatMap(DatabaseMigration.apply),
      Effect.provideService(Global.Service, Global.make({ data })),
      Effect.provide(SqliteClient.layer({ filename: file, disableWAL: true })),
      Effect.scoped,
    ),
  )
}

// What each table is to SQLite, one line per fact about it. Columns are named, not numbered: a migration adds
// a column after the others, where the declaration may list it earlier.
function structure(file: string) {
  const database = new Database(file, { readonly: true })
  const all = (query: string) => database.query(query).all() as Record<string, unknown>[]
  const definition = (name: unknown) =>
    String((database.query("SELECT sql FROM sqlite_master WHERE name = ?").get(String(name)) as { sql: unknown })?.sql)
      .replaceAll(/[`"]/g, "")
      .replaceAll(/\s+/g, " ")
  const tables = all(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'migration'",
  ).map((table) => String(table.name))
  const facts = tables.flatMap((table) => [
    `${table} table${/\bAUTOINCREMENT\b/i.test(definition(table)) ? " autoincrement" : ""}`,
    ...all(`PRAGMA table_xinfo("${table}")`).map(
      ({ cid: _, ...column }) => `${table} column ${JSON.stringify(column)}`,
    ),
    ...all(`PRAGMA index_list("${table}")`).map(({ seq: _, ...index }) => {
      const implicit = String(index.name).startsWith("sqlite_autoindex_")
      return `${table} index ${JSON.stringify({
        ...index,
        name: implicit ? undefined : index.name,
        columns: all(`PRAGMA index_info("${index.name}")`).map((column) => column.name),
        sql: implicit ? undefined : definition(index.name),
      })}`
    }),
    ...all(`PRAGMA foreign_key_list("${table}")`).map(
      ({ id: _, ...key }) => `${table} foreign key ${JSON.stringify(key)}`,
    ),
  ])
  database.close()
  return facts
}

function renderRun(statement: string) {
  const lines = statement.replaceAll("\t", "  ").split("\n")
  if (lines.length === 1) return `      yield* tx.run(\`${escapeTemplate(lines[0])}\`)`
  return `      yield* tx.run(\`\n${lines.map((line) => `        ${escapeTemplate(line)}`).join("\n")}\n      \`)`
}

function escapeTemplate(line: string) {
  return line.replaceAll("\\", "\\\\").replaceAll("`", "\\`").replaceAll("${", "\\${")
}

async function formatTypescript(input: string) {
  const prettier = await import("prettier")
  const typescript = await import("prettier/plugins/typescript")
  const estree = await import("prettier/plugins/estree")
  return prettier.format(input, {
    parser: "typescript",
    plugins: [typescript.default, estree.default],
    semi: false,
    printWidth: 120,
  })
}

// Drizzle emits every array multi-line; format the snapshot so regeneration
// diffs stay minimal against the prettier-styled checked-in copy.
async function formatJson(input: string) {
  const prettier = await import("prettier")
  const babel = await import("prettier/plugins/babel")
  const estree = await import("prettier/plugins/estree")
  return prettier.format(input, {
    parser: "json",
    plugins: [babel.default, estree.default],
    printWidth: 120,
  })
}

function renderRegistry(names: string[]) {
  return `import type { DatabaseMigration } from "./migration.js"
${names.map((name, index) => `import m${index.toString().padStart(2, "0")} from "./migration/${name}.js"`).join("\n")}

export const migrations = [
${names.map((_, index) => `  m${index.toString().padStart(2, "0")},`).join("\n")}
] satisfies DatabaseMigration.Migration[]
`
}
