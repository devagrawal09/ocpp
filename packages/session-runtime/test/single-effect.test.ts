import { expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Effect } from "effect"

// Each linked Specter package resolves effect from its Specter checkout; the preload (bunfig.toml)
// makes every such copy OC++'s own. With two copies, this fails.
test("the linked Specter packages load OC++'s Effect", async () => {
  const loaded = await Promise.all(
    ["@specter-ts/core", "@specter-ts/memory", "@specter-ts/reaction-outbox", "@specter-ts/jsonl"].map(
      (name) =>
        import(Bun.resolveSync("effect", path.dirname(fs.realpathSync(Bun.resolveSync(name, import.meta.dir))))),
    ),
  )
  loaded.forEach((module) => expect(module.Effect).toBe(Effect))
})
