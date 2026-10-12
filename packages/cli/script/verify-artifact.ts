import { stat } from "node:fs/promises"
import path from "node:path"
import { collectFiles } from "./files"

const forbidden = [
  "@napi-rs/canvas",
  "@fontsource/commit-mono",
  "@fontsource/noto-sans",
  "SimulationPng",
  "frontend/png",
  "Failed to register screenshot font",
  "commit-mono-latin-400-normal",
  "noto-sans-symbols-symbols-400-normal",
  "noto-sans-math-math-400-normal",
  "CommitMono-400-Regular.otf",
  "NotoSansSymbols.ttf",
  "src/frontend/png.ts",
  "skia.darwin-",
  "skia.linux-",
  "skia.win32-",
]
const overlap = Math.max(...forbidden.map((value) => value.length)) - 1

export async function verifyArtifact(target: string) {
  const files = await artifactFiles(target)
  if (files.length === 0) throw new Error(`Artifact contains no published files: ${target}`)
  for (const file of files) await scan(file)
}

export function verifySimulationGraph(inputs: Iterable<string>) {
  const modules = Array.from(inputs, (input) => input.replaceAll("\\", "/"))
  const required = ["/packages/simulation/src/backend/index.ts", "/packages/simulation/src/control-server.ts"]
  const missing = required.filter((input) => !modules.some((module) => module.endsWith(input)))
  if (missing.length > 0) throw new Error(`Build graph is missing simulation bridge inputs: ${missing.join(", ")}`)
}

/** The bundle's effect modules all come from one copy of effect: OC++'s. */
export function verifySingleEffect(inputs: Iterable<string>) {
  const copies = new Set(
    Array.from(inputs, (input) => {
      const module = input.replaceAll("\\", "/")
      return module.slice(0, module.lastIndexOf("/effect/dist/") + "/effect".length)
    }),
  )
  if (copies.size !== 1)
    throw new Error(`Build graph must load exactly one copy of effect, found ${copies.size}: ${[...copies].join(", ")}`)
}

async function artifactFiles(target: string): Promise<string[]> {
  if ((await stat(target)).isFile()) return [target]
  return (await collectFiles(target)).map((file) => path.join(target, file))
}

async function scan(file: string) {
  let trailing = ""
  const reader = Bun.file(file).stream().getReader()
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) return
    const text = trailing + Buffer.from(chunk.value).toString("latin1")
    const leaked = forbidden.find((marker) => text.includes(marker))
    if (leaked) throw new Error(`Artifact file ${file} contains forbidden simulation payload: ${leaked}`)
    trailing = text.slice(-overlap)
  }
}

if (import.meta.main) {
  const target = process.argv[2]
  if (!target) throw new Error("Usage: bun run script/verify-artifact.ts <file-or-directory>")
  await verifyArtifact(target)
}
