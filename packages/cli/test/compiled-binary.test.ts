import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { isolatedEnv } from "./fixture/environment"

// Builds the release binary for this platform as a release does, without the web UI or a cross-platform
// install. The build fails unless the bundle loads exactly one copy of effect, OC++'s, which the linked
// Specter packages share through the single-Effect plugin. The binary then creates a Session, which OC++
// decides through a Specter Command: OC++ and Specter's core run on that one Effect.
test("the compiled binary carries one Effect and runs a Session Command", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ocpp-cli-binary-")))
  try {
    const build = Bun.spawn(
      [
        process.execPath,
        "run",
        "script/build.ts",
        "--single",
        "--skip-install",
        "--skip-web-ui",
        `--outdir=${path.join(root, "dist")}`,
      ],
      {
        cwd: path.join(import.meta.dir, ".."),
        env: { ...process.env, OCPP_CHANNEL: "smoke" },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
      },
    )
    const [built, buildErrors] = await Promise.all([build.exited, new Response(build.stderr).text()])
    expect({ exitCode: built, stderr: built === 0 ? "" : buildErrors }).toEqual({ exitCode: 0, stderr: "" })

    const platform = process.platform === "win32" ? "windows" : process.platform
    const binary = path.join(
      root,
      "dist",
      `cli-${platform}-${process.arch}`,
      "bin",
      `ocpp${platform === "windows" ? ".exe" : ""}`,
    )
    const project = path.join(root, "project")
    await fs.mkdir(project)
    await fs.mkdir(path.join(root, "home"))
    const create = Bun.spawn([binary, "api", "--standalone", "POST", "/api/session", "-d", "{}"], {
      cwd: project,
      env: isolatedEnv(path.join(root, "home")),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [created, stdout, stderr] = await Promise.all([
      create.exited,
      new Response(create.stdout).text(),
      new Response(create.stderr).text(),
    ])
    expect({ exitCode: created, stderr: created === 0 ? "" : stderr }).toEqual({ exitCode: 0, stderr: "" })
    expect(JSON.parse(stdout)).toMatchObject({
      data: { id: expect.stringMatching(/^ses_/), location: { directory: project } },
    })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
}, 180_000)
