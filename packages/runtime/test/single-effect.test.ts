import { expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Effect } from "effect"

// Each linked Specter package resolves effect from its Specter checkout; the preload (bunfig.toml)
// makes every such copy OC++'s own. With two copies, this fails.
test("the linked Specter packages load OC++'s Effect", async () => {
  const loaded = await Promise.all(
    [
      "@specter-ts/core",
      "@specter-ts/memory",
      "@specter-ts/reaction-outbox",
      "@specter-ts/jsonl",
      "@specter-ts/sqlite",
    ].map(
      (name) =>
        import(Bun.resolveSync("effect", path.dirname(fs.realpathSync(Bun.resolveSync(name, import.meta.dir))))),
    ),
  )
  loaded.forEach((module) => expect(module.Effect).toBe(Effect))
})

// A linked package's import of another Specter package resolves, in the Specter checkout, to that package's build: the
// one OC++ links. Bun applies a linked package's tsconfig `paths`, so a source mapping there would load it twice.
test("the linked Specter packages resolve each other to the builds OC++ links", () => {
  const linked = [
    "@specter-ts/core",
    "@specter-ts/memory",
    "@specter-ts/reaction-outbox",
    "@specter-ts/jsonl",
    "@specter-ts/sqlite",
    "@specter-ts/spec",
  ]
  const entry = (name: string) => fs.realpathSync(Bun.resolveSync(name, import.meta.dir))
  const imports = linked.flatMap((name) => {
    const build = path.dirname(entry(name))
    const manifest = JSON.parse(fs.readFileSync(path.join(build, "..", "package.json"), "utf8"))
    return Object.keys(manifest.dependencies ?? {})
      .filter((dependency) => linked.includes(dependency))
      .map((dependency) => [name, dependency, fs.realpathSync(Bun.resolveSync(dependency, build))])
  })
  expect(imports.length).toBeGreaterThan(0)
  expect(imports).toEqual(imports.map(([name, dependency]) => [name, dependency, entry(dependency!)]))
})

// So an error one package throws is the class another checks.
test("the linked Specter packages load each other as OC++ links them", async () => {
  const { createMemoryEventLog } = await import("@specter-ts/memory")
  const { createSqliteReactionOutboxStore } = await import("@specter-ts/sqlite")
  const { SpecterVersionConflictError } = await import("@specter-ts/core")
  const { ReactionOutboxLeaseLostError } = await import("@specter-ts/reaction-outbox")
  const log = createMemoryEventLog()
  await Effect.runPromise(log.append([{ type: "noted", payload: {}, keys: {} }]))
  const stale = await Effect.runPromise(
    Effect.flip(log.append([{ type: "noted", payload: {}, keys: {} }], { expectedVersion: 0 })),
  )
  expect(stale.cause).toBeInstanceOf(SpecterVersionConflictError)
  // An outbox Store that finds no active attempt fails with the outbox package's own error.
  const lost = await Effect.runPromise(
    Effect.flip(
      createSqliteReactionOutboxStore({
        execute: () => Effect.succeed([]),
        use: (run) => run(undefined),
        transaction: (run) => run(undefined),
      }).complete("job", "attempt", new Date()),
    ),
  )
  expect(lost).toBeInstanceOf(ReactionOutboxLeaseLostError)
})
