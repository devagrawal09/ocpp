import { afterAll, beforeAll, expect, test } from "bun:test"
import { control } from "./control"

const health = Bun.serve({ port: 0, fetch: () => Response.json({ healthy: true, version: "test" }) })
const app = control({
  username: "admin",
  password: "test-password-long-enough",
  command: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
  directory: import.meta.dir,
  healthURL: `http://127.0.0.1:${health.port}/`,
  tailscale: [process.execPath, "-e", "process.exit(1)", "--"],
})
const authorization = `Basic ${Buffer.from("admin:test-password-long-enough").toString("base64")}`

beforeAll(() => app.start())
afterAll(async () => {
  await app.shutdown()
  health.stop(true)
})

test("only the minimal platform health check is public", async () => {
  expect((await app.handler(new Request("https://control.test/health"))).status).toBe(200)
  for (const path of ["/", "/api/status", "/api/restart"]) {
    const response = await app.handler(new Request(`https://control.test${path}`))
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain("Basic")
    expect(response.headers.get("cache-control")).toBe("no-store")
  }
  expect(
    (await app.handler(new Request("https://control.test/", { headers: { authorization: "Basic invalid" } }))).status,
  ).toBe(401)
})

test("authenticated status observes the real child and health endpoint", async () => {
  const response = await app.handler(new Request("https://control.test/api/status", { headers: { authorization } }))
  const data = await response.json()
  expect(data.ocpp.running).toBe(true)
  expect(data.ocpp.healthy).toBe(true)
  expect(data.ocpp.pid).toBeGreaterThan(0)
  expect(data.tailscale.state).toBe("Unavailable")
})

test("a crashed child is automatically restarted", async () => {
  const before = (await app.status()).ocpp.pid
  if (!before) throw new Error("Missing child process")
  process.kill(before, "SIGKILL")
  await Bun.sleep(2200)
  const after = await app.status()
  expect(after.ocpp.pid).not.toBe(before)
  expect(after.ocpp.running).toBe(true)
})

test("restart requires both a page token and a same-host origin", async () => {
  const page = await app.handler(new Request("https://control.test/", { headers: { authorization } }))
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
  const token = (await page.text()).split('const csrf = "')[1].split('"')[0]
  const attempts: HeadersInit[] = [
    { authorization },
    { authorization, origin: "https://control.test" },
    { authorization, origin: "https://attacker.test", "x-csrf-token": token },
    { authorization, origin: "null", "x-csrf-token": token },
  ]
  for (const headers of attempts) {
    expect(
      (await app.handler(new Request("https://control.test/api/restart", { method: "POST", headers }))).status,
    ).toBe(403)
  }
  const before = (await app.status()).ocpp.pid
  expect(
    (
      await app.handler(
        new Request("https://control.test/api/restart", {
          method: "POST",
          headers: { authorization, origin: "https://control.test", "x-csrf-token": token },
        }),
      )
    ).status,
  ).toBe(200)
  expect((await app.status()).ocpp.pid).not.toBe(before)
  expect((await app.status()).ocpp.running).toBe(true)
})
