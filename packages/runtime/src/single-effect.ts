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
 * The checkout's tsconfig `paths` map Specter's packages to their sources, and Bun applies them to the
 * linked packages' own imports, so `@specter-ts/sqlite` importing `@specter-ts/core` would load core a
 * second time, from source, and its errors would not be the classes the runtime checks. The plugin
 * resolves a linked package's import of another Specter package as the published package does: to the
 * build OC++ links.
 *
 * A process installs it (`installSingleEffect`), and a bundle lists it among its build plugins, as the
 * CLI's compiled binary does. It is undefined when there is no second copy of `effect`.
 *
 * It exists only because of the links: once the Specter packages are installed from a registry or a
 * packed tarball, they resolve `effect` and each other from OC++'s `node_modules`, and this plugin and
 * the `effect` `paths` in the tsconfigs can go.
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
  // Each linked package's directory: its `dist` holds the entry.
  const sources = linkedSources(entries.map((entry) => path.dirname(path.dirname(entry))))
  return {
    name: "ocpp-single-effect",
    setup(build) {
      sources.forEach((linked, source) => {
        build.onLoad({ filter: new RegExp(`^${escape(source)}$`) }, () => ({
          contents: `export * from ${JSON.stringify(linked)}`,
          loader: "js",
        }))
      })
      foreign.forEach((root) => {
        build.onLoad({ filter: new RegExp(`^${escape(path.join(root, "dist"))}[\\\\/].+\\.js$`) }, (args) => ({
          contents: `export * from ${JSON.stringify(path.join(host, path.relative(root, args.path)))}`,
          loader: "js",
        }))
      })
    },
  }
}

/**
 * The sources the linked packages' tsconfig `paths` map Specter's packages to, each with the build OC++ links for
 * that package: what a linked package's import of another must load instead.
 */
function linkedSources(directories: readonly string[]) {
  const sources = new Map<string, string>()
  directories.forEach((directory) => {
    for (let file: string | undefined = path.join(directory, "tsconfig.json"); file && fs.existsSync(file); ) {
      const config = JSON.parse(fs.readFileSync(file, "utf8"))
      Object.entries<string[]>(config.compilerOptions?.paths ?? {}).forEach(([specifier, [target]]) => {
        if (!specifier.startsWith("@specter-ts/") || !target) return
        const linked = Bun.resolveSync(specifier, import.meta.dir)
        sources.set(path.resolve(path.dirname(file!), target), fs.realpathSync(linked))
      })
      file = config.extends ? path.resolve(path.dirname(file), config.extends) : undefined
    }
  })
  return sources
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
