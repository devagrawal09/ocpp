import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { createMcpBridge } from "../src/mcp-bridge"

const token = "test-key-".repeat(8)
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: createMcpBridge({
    baseUrl: "http://127.0.0.1:1",
    directory: process.cwd(),
    token,
    sessions: new Set(),
    register: async () => {},
  }),
})
afterAll(() => server.stop(true))

describe("local MCP bridge", () => {
  test("starts with a fresh private key and reuses it after restart", async () => {
    const state = await mkdtemp(join(tmpdir(), "ocpp-mcp-"))
    try {
      const keys = []
      for (const attempt of [0, 1]) {
        const child = Bun.spawn([process.execPath, "script/mcp-bridge.ts"], {
          cwd: new URL("..", import.meta.url).pathname,
          env: { ...process.env, OCPP_URL: "http://127.0.0.1:1", OCPP_BRIDGE_STATE: state, OCPP_BRIDGE_PORT: "0" },
          stdout: "pipe",
          stderr: "inherit",
        })
        try {
          const reader = child.stdout.getReader()
          expect(new TextDecoder().decode((await reader.read()).value)).toContain("MCP endpoint:")
          reader.releaseLock()
          keys.push((await Bun.file(join(state, "key")).text()).trim())
          expect(keys[attempt]).toHaveLength(64)
          expect((await stat(join(state, "key"))).mode & 0o777).toBe(0o600)
        } finally {
          child.kill()
          await child.exited
        }
      }
      expect(keys[0]).toBe(keys[1])
    } finally {
      await rm(state, { recursive: true, force: true })
    }
  })

  test("requires the exact bearer key", async () => {
    for (const authorization of [undefined, "Bearer wrong", `Bearer ${token.slice(1)}x`]) {
      const response = await fetch(new URL("/mcp", server.url), {
        method: "POST",
        headers: authorization ? { authorization } : {},
      })
      expect(response.status).toBe(401)
      expect(response.headers.get("www-authenticate")).toBe("Bearer")
    }
  })

  test("rejects browser origins and does not proxy arbitrary API paths", async () => {
    const headers = { authorization: `Bearer ${token}` }
    expect(
      (await fetch(new URL("/mcp", server.url), { headers: { ...headers, origin: "https://example.com" } })).status,
    ).toBe(403)
    expect((await fetch(new URL("/api/session", server.url), { headers })).status).toBe(404)
    expect((await fetch(new URL("/mcp", server.url), { headers })).status).toBe(405)
  })

  test("speaks MCP and rejects unowned sessions before contacting OC++", async () => {
    const client = new Client({ name: "bridge-test", version: "1" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL("/mcp", server.url), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    )
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "create_session",
      "send_prompt",
      "get_session",
    ])
    for (const name of ["get_session", "send_prompt"]) {
      const result = await client.callTool({ name, arguments: { sessionID: "ses_existing", text: "do not run" } })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain("not owned by this bridge")
    }
    const invalid = await client.callTool({
      name: "get_session",
      arguments: { sessionID: "ses_existing", limit: 1000 },
    })
    expect(invalid.isError).toBe(true)
    await client.close()
  })
})
