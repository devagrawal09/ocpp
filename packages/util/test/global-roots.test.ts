import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"

const module = pathToFileURL(path.join(import.meta.dir, "../src/global-roots.ts")).href

describe("global roots", () => {
  test("uses XDG overrides", () => {
    const root = path.join(os.tmpdir(), "ocpp-xdg-overrides")
    const env = {
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_CONFIG_HOME: path.join(root, "config"),
      XDG_STATE_HOME: path.join(root, "state"),
    }

    expect(run(env)).toEqual({
      data: path.join(env.XDG_DATA_HOME, "ocpp"),
      cache: path.join(env.XDG_CACHE_HOME, "ocpp"),
      config: path.join(env.XDG_CONFIG_HOME, "ocpp"),
      state: path.join(env.XDG_STATE_HOME, "ocpp"),
      tmp: path.join(os.tmpdir(), "ocpp"),
    })
  })

  test("empty XDG overrides use home directory defaults", () => {
    const home = path.join(os.tmpdir(), "ocpp-xdg-home")

    expect(
      run({
        XDG_DATA_HOME: "",
        XDG_CACHE_HOME: "",
        XDG_CONFIG_HOME: "",
        XDG_STATE_HOME: "",
        ...(process.platform === "win32" ? { USERPROFILE: home } : { HOME: home }),
      }),
    ).toEqual({
      data: path.join(home, ".local", "share", "ocpp"),
      cache: path.join(home, ".cache", "ocpp"),
      config: path.join(home, ".config", "ocpp"),
      state: path.join(home, ".local", "state", "ocpp"),
      tmp: path.join(os.tmpdir(), "ocpp"),
    })
  })
})

function run(env: Record<string, string>) {
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `const { roots } = await import(${JSON.stringify(module)}); console.log(JSON.stringify(roots("ocpp")))`,
    ],
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })

  expect(result.exitCode, result.stderr.toString()).toBe(0)
  return JSON.parse(result.stdout.toString())
}
