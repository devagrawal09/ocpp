import { plugin, type BunPlugin } from "bun"
import fs from "fs"
import path from "path"

// The Specter packages this package links that import `effect`.
const linked = [
  "@specter-ts/core",
  "@specter-ts/memory",
  "@specter-ts/reaction-outbox",
  "@specter-ts/jsonl",
  "@specter-ts/sqlite",
]

/**
 * Installs the plugin in this process. Run it before any Specter package is imported (a Bun preload).
 */
export function installSingleEffect() {
  const single = singleEffect()
  if (single) plugin(single)
}

/**
 * This package depends on Specter's packages through `link:`, so each resolves to a Specter checkout
 * that has its own `node_modules`, and their imports of `effect` load a second copy from there. Two
 * copies are two runtimes: symbols, Context keys and fibers stop matching across the boundary. This
 * plugin makes every `effect` module file loaded from such a copy re-export the same file from OC++'s
 * copy, so the process runs one Effect. Both copies must be the same version.
 *
 * Only `effect` needs it: a linked package's import of another Specter package resolves, in the
 * checkout, to that package's build, the one OC++ links (Specter keeps its source mappings out of the
 * tsconfig its packages ship, which Bun would apply).
 *
 * A process installs it (`installSingleEffect`), and a bundle lists it among its build plugins, as the
 * CLI's compiled binary does. It is undefined when there is no second copy of `effect`.
 *
 * It exists only because of the links: once the Specter packages are installed from a registry or a
 * packed tarball, they resolve `effect` from OC++'s `node_modules`, and this plugin and the `effect`
 * `paths` in the tsconfigs can go.
 */
export function singleEffect(): BunPlugin | undefined {
  const host = effectRoot(import.meta.dir)
  // A devDependency is missing from a production install.
  const installed = linked.filter((name) => fs.existsSync(path.join(import.meta.dir, "..", "node_modules", name)))
  const entries = installed.map((name) => fs.realpathSync(Bun.resolveSync(name, import.meta.dir)))
  const foreign = [...new Set(entries.map((entry) => effectRoot(path.dirname(entry))))].filter((root) => root !== host)
  if (foreign.length === 0) return
  const hostVersion = readVersion(host)
  foreign.forEach((root) => {
    const version = readVersion(root)
    if (version !== hostVersion)
      throw new Error(`The linked Specter packages' effect ${version} cannot share OC++'s effect ${hostVersion}`)
  })
  return {
    name: "ocpp-single-effect",
    setup(build) {
      foreign.forEach((root) => {
        build.onLoad({ filter: new RegExp(`^${escape(path.join(root, "dist"))}[\\\\/].+\\.js$`) }, (args) => ({
          contents: `export * from ${JSON.stringify(path.join(host, path.relative(root, args.path)))}`,
          loader: "js",
        }))
      })
    },
  }
}

function effectRoot(from: string) {
  const entry = fs.realpathSync(Bun.resolveSync("effect", from))
  const name = `${path.sep}effect`
  return entry.slice(0, entry.lastIndexOf(`${name}${path.sep}dist${path.sep}`) + name.length)
}

function readVersion(root: string): string {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version
}

function escape(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
