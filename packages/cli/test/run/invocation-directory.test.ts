import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { invocationDirectory } from "../../src/run/run"

const base = realpathSync(mkdtempSync(path.join(tmpdir(), "ocpp-invocation-")))
const task = path.join(base, "task")
const other = path.join(base, "other")
const link = path.join(base, "link")
const cliPackage = path.join(base, "packages", "cli")
mkdirSync(task)
mkdirSync(other)
mkdirSync(cliPackage, { recursive: true })
symlinkSync(task, link)

afterAll(() => rmSync(base, { recursive: true, force: true }))

describe("invocationDirectory", () => {
  test("uses the working directory when $PWD is stale", () => {
    expect(invocationDirectory(task, other, cliPackage)).toBe(task)
  })

  test("keeps the symlinked $PWD when it names the working directory", () => {
    expect(invocationDirectory(task, link, cliPackage)).toBe(link)
  })

  test("uses $PWD when the dev script started the CLI in its package directory", () => {
    expect(invocationDirectory(cliPackage, other, cliPackage)).toBe(other)
  })

  test("uses the working directory without $PWD or when $PWD does not exist", () => {
    expect(invocationDirectory(task, undefined, cliPackage)).toBe(task)
    expect(invocationDirectory(task, path.join(base, "missing"), cliPackage)).toBe(task)
  })
})
