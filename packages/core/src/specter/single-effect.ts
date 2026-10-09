import { plugin } from "bun"
import fs from "fs"
import path from "path"

/**
 * The embedded Specter runtime is linked from a sibling checkout that has its own `node_modules`, so
 * its imports of `effect` resolve to a second copy. Two copies are two runtimes: symbols, Context
 * keys and fibers stop matching across the boundary. This plugin makes every `effect` module file
 * loaded from the runtime's copy re-export the same file from OC++'s copy, so the process runs one
 * Effect. Both copies must be the same version. Install it before the runtime is imported (a Bun
 * preload).
 */
export function installSingleEffect() {
  const host = effectRoot(import.meta.dir)
  const runtime = path.dirname(fs.realpathSync(Bun.resolveSync("@specter/agent-runtime", import.meta.dir)))
  const foreign = effectRoot(runtime)
  if (foreign === host) return
  const [hostVersion, foreignVersion] = [readVersion(host), readVersion(foreign)]
  if (hostVersion !== foreignVersion)
    throw new Error(`The Specter runtime's effect ${foreignVersion} cannot share OC++'s effect ${hostVersion}`)
  const files = new RegExp(`^${escape(path.join(foreign, "dist"))}[\\\\/].+\\.js$`)
  plugin({
    name: "ocpp-single-effect",
    setup(build) {
      build.onLoad({ filter: files }, (args) => ({
        contents: `export * from ${JSON.stringify(path.join(host, path.relative(foreign, args.path)))}`,
        loader: "js",
      }))
    },
  })
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
