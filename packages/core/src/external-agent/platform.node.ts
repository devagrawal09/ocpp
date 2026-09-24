import { spawn } from "node:child_process"
import { ExternalSession } from "@opencode-ai/schema/external-session"
import { which } from "../util/which.js"
import type { ExternalAgentDriver } from "./driver.js"

const packages = {
  claude: "@anthropic-ai/claude-agent-sdk",
  codex: "@openai/codex-sdk",
  pi: "@earendil-works/pi-coding-agent",
}
export async function available(provider: ExternalSession.Provider): Promise<boolean> {
  if (provider !== "pi" && !which(provider)) return false
  const resolved = await Promise.resolve()
    .then(() => import.meta.resolve(packages[provider]))
    .catch(() => undefined)
  if (!resolved) return false
  if (provider === "pi") {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent")
    const runtime = await ModelRuntime.create({ allowModelNetwork: false })
    return runtime.getProviders().some((provider) => runtime.hasConfiguredAuth(provider.id))
  }
  if (provider === "claude" && (process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN)) return true
  if (provider === "codex" && (process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY)) return true
  // Authentication status is read once per Location/config lifecycle, never per model request.
  return new Promise((resolve) => {
    const child = spawn(provider, provider === "claude" ? ["auth", "status"] : ["login", "status"], {
      stdio: "ignore",
      timeout: 5000,
    })
    child.once("error", () => resolve(false))
    child.once("exit", (code) => resolve(code === 0))
  })
}
export async function driver(provider: ExternalSession.Provider): Promise<ExternalAgentDriver.Driver> {
  if (provider === "claude") {
    const { ClaudeDriver } = await import("./claude.node.js")
    return ClaudeDriver
  }
  if (provider === "codex") {
    const { CodexDriver } = await import("./codex.node.js")
    return CodexDriver
  }
  const { PiDriver } = await import("./pi.node.js")
  return PiDriver
}
