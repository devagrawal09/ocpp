import { appendFile, chmod, mkdir, writeFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { createMcpBridge } from "../src/mcp-bridge"

const baseUrl = process.env.OCPP_URL
if (!baseUrl) throw new Error("Set OCPP_URL to the running local OC++ service URL")
const directory = resolve(process.env.OCPP_BRIDGE_DIRECTORY ?? process.cwd())
const state = process.env.OCPP_BRIDGE_STATE ?? join(homedir(), ".local/share/ocpp/mcp-bridge")
await mkdir(state, { recursive: true, mode: 0o700 })
await chmod(state, 0o700)
const key = join(state, "key")
if (!(await Bun.file(key).exists())) await writeFile(key, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" })
await chmod(key, 0o600)
const ledger = join(state, "sessions")
const sessions = new Set(
  (await Bun.file(ledger).exists()) ? (await Bun.file(ledger).text()).split("\n").filter(Boolean) : [],
)
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.OCPP_BRIDGE_PORT ?? 49376),
  maxRequestBodySize: 1024 * 1024,
  fetch: createMcpBridge({
    baseUrl,
    directory,
    token: (await Bun.file(key).text()).trim(),
    sessions,
    register: (sessionID) => appendFile(ledger, `${sessionID}\n`, { mode: 0o600 }),
  }),
})
console.log(`MCP endpoint: ${server.url}mcp`)
console.log(`Working directory: ${directory}`)
console.log(`Bearer key file: ${key}`)
console.log("Expose only this bridge port through your HTTPS tunnel, not the OC++ service port.")
process.on("SIGINT", () => {
  server.stop(true)
  process.exit(0)
})
process.on("SIGTERM", () => {
  server.stop(true)
  process.exit(0)
})
