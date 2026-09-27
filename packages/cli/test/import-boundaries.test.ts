import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")

describe("CLI frontend import boundaries", () => {
  test("does not import Core directly", async () => {
    const glob = new Bun.Glob("{src,test}/**/*.{ts,tsx}")
    const imports: string[] = []
    for await (const file of glob.scan({ cwd: path.join(root, "packages/cli") })) {
      const source = await Bun.file(path.join(root, "packages/cli", file)).text()
      if (/["']@ocpp\/core(?:\/[^"']*)?["']/.test(source)) imports.push(file)
    }
    expect(imports).toEqual([])
  })

  test("exposes only the intentional package entrypoints", async () => {
    const run = await import("@ocpp/cli/run")
    const cli = await Bun.file(path.join(root, "packages/cli/package.json")).json()

    expect(Object.keys(run).sort()).toEqual(["runNonInteractive", "runV1Bridge"])
    expect(Object.keys(cli.exports).filter((key) => key === "./mini" || key.startsWith("./mini/"))).toEqual([])
  })

  test("keeps run free of interactive terminal UI", async () => {
    const run = await bundleInputs("packages/cli/src/commands/handlers/run.ts")
    expect(run).toContain("packages/cli/src/run/run.ts")
    expect(run).toContain("packages/cli/src/run/tool-display.ts")
    expect(run).toContain("packages/cli/src/util/error.ts")
    expect(run).not.toContain("packages/cli/src/ui/prompt.ts")
    expect(run).not.toContain("packages/cli/src/ui/timeline.tsx")
    expect(run.filter((file) => file.includes("@opentui/"))).toEqual([])
  })
})

async function bundleInputs(entrypoint: string) {
  const temporary = await mkdtemp(path.join(import.meta.dir, ".import-boundary-"))
  const metafile = path.join(temporary, "meta.json")
  try {
    const child = Bun.spawn(
      [
        process.execPath,
        "build",
        entrypoint,
        "--target=bun",
        "--format=esm",
        "--packages=bundle",
        "--external=@opentui/core-*",
        `--metafile=${metafile}`,
        `--outdir=${path.join(temporary, "out")}`,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    )
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exitCode !== 0) throw new Error(stdout + stderr)
    const metadata = await Bun.file(metafile).json()
    return Object.keys(metadata.inputs).map((input) =>
      path.relative(root, path.resolve(root, input)).replaceAll(path.sep, "/"),
    )
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
