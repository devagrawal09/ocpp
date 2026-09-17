import { expect, test } from "bun:test"
import { Effect } from "effect"
import { ExternalSession } from "@opencode-ai/schema/external-session"
import { ExternalAgentGateway } from "../src/external-agent/gateway"
import { ExternalAgentDriver } from "../src/external-agent/driver"
import { driver } from "../src/external-agent/platform.node"
import { tmpdir } from "./fixture/tmpdir"

// Explicitly opt in with OPENCODE_EXTERNAL_LIVE=claude,codex,pi and vendor authentication.
// This sends paid model requests. Normal deterministic tests never invoke a model.
const enabled = (process.env.OPENCODE_EXTERNAL_LIVE ?? "").split(",")
const models = { claude: "sonnet", codex: "gpt-5.6-sol", pi: "anthropic/claude-sonnet-4-6" }
for (const provider of ExternalSession.Provider.literals)
  test.skipIf(!enabled.includes(provider))(
    `${provider}: live private structured output and exact continuation`,
    async () => {
      await using dir = await tmpdir()
      const sdk = await driver(provider)
      const identity = { id: undefined as string | undefined, checkpoint: undefined as string | undefined }
      for (const value of [1, 2]) {
        const gateway = await Effect.runPromise(
          ExternalAgentGateway.make({
            input: { value, token: "machine-only-token" },
            inputSchema: { type: "object", required: ["value", "token"] },
            outputSchema: {
              type: "object",
              properties: { value: { type: "number" }, token: { type: "string" } },
              required: ["value", "token"],
            },
          }),
        )
        const events: ExternalAgentDriver.Event[] = []
        const signal = AbortSignal.timeout(180_000)
        try {
          if (identity.id !== undefined)
            ExternalAgentDriver.check(identity.checkpoint, (await sdk.inspect(dir.path, identity.id, signal))!)
          await sdk.run({
            directory: dir.path,
            model: process.env[`OPENCODE_EXTERNAL_LIVE_${provider.toUpperCase()}_MODEL`] ?? models[provider],
            history: [],
            message:
              'Call the OpenCode execute tool with this code and finish: const submitted = tools.submit_result({message: "done", output: {value: input.value + 1, token: input.token}}). Do not print private input. No filesystem or shell work is needed.',
            gateway,
            signal,
            vendorSessionID: identity.id,
            checkpoint: identity.checkpoint,
            linked: async (id) => {
              if (identity.id !== undefined) expect(id).toBe(identity.id)
              identity.id = id
            },
            checkpointed: async (checkpoint) => {
              identity.checkpoint = checkpoint
            },
            emit: async (event) => {
              events.push(event)
            },
            authorize: async (name) => {
              if (name !== "workspace" && !name.endsWith("execute") && !name.endsWith("submit_result"))
                throw new Error("Live fixture permits only delegated tools")
            },
          })
          expect(gateway.result()).toEqual({
            message: "done",
            output: { value: value + 1, token: "machine-only-token" },
          })
          expect(identity.id).toBeString()
          expect(identity.checkpoint).toBeString()
          expect(events.some((event) => event.type === "tool-start")).toBe(true)
        } finally {
          gateway.close()
        }
      }
    },
    400_000,
  )
