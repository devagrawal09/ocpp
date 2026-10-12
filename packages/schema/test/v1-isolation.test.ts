import { expect, test } from "bun:test"
import { PermissionV1 } from "../src/permission-v1.js"
import { SessionV1 } from "../src/session-v1.js"
const isolatedPermission = await import("../src/v1/permission.js")
const isolatedSession = await import("../src/v1/session.js")

test("compatibility entrypoints preserve isolated V1 schema identity", () => {
  expect(PermissionV1).toBe(isolatedPermission.PermissionV1)
  expect(SessionV1).toBe(isolatedSession.SessionV1)
})

test("current source does not import the V1 subtree directly", async () => {
  const allowed = new Set(["permission-v1.ts", "session-v1.ts"])
  const files = [...new Bun.Glob("*.ts").scanSync(new URL("../src", import.meta.url).pathname)].filter(
    (file) => !allowed.has(file),
  )
  const directImports = await Promise.all(
    files.map(async (file) => ({ file, source: await Bun.file(new URL(`../src/${file}`, import.meta.url)).text() })),
  ).then((values) => values.filter((value) => value.source.includes('from "./v1/')))

  expect(directImports).toEqual([])
})
