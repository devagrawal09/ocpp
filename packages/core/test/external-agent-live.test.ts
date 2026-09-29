import { expect, test } from "bun:test"
import { Effect } from "effect"
import { ExternalSession } from "@ocpp/schema/external-session"
import { ExternalAgentGateway } from "../src/external-agent/gateway"
import { ExternalAgentDriver } from "../src/external-agent/driver"
import { driver } from "../src/external-agent/platform.node"
import { tmpdir } from "./fixture/tmpdir"

// Explicitly opt in with OCPP_EXTERNAL_LIVE=claude,codex,pi and vendor authentication.
// This sends paid model requests. Normal deterministic tests never invoke a model.
const enabled = (process.env.OCPP_EXTERNAL_LIVE ?? "").split(",")
const models = { claude: "sonnet", codex: "gpt-5.6-sol", pi: "anthropic/claude-sonnet-4-6" }
for (const provider of ExternalSession.Provider.literals)
  test.skipIf(!enabled.includes(provider))(
    `${provider}: live OC++ harness execute call, idle input and exact continuation`,
    async () => {
      await using dir = await tmpdir()
      const sdk = await driver(provider)
      const calls: string[] = []
      const gateway = ExternalAgentGateway.make([
        {
          name: "execute",
          description: "Run an OC++ Code Mode program. Returns an execution ID; the outcome arrives later.",
          inputSchema: {
            type: "object",
            properties: { code: { type: "string" } },
            required: ["code"],
            additionalProperties: false,
          },
          invoke: (input) =>
            Effect.sync(() => {
              calls.push(String(input.code))
              return "Execution exe_live started. Its outcome arrives in a later notification."
            }),
        },
      ])
      const identity = { id: undefined as string | undefined, checkpoint: undefined as string | undefined }
      for (const round of [1, 2]) {
        const events: ExternalAgentDriver.Event[] = []
        const signal = AbortSignal.timeout(180_000)
        const queue =
          round === 1
            ? [
                [
                  {
                    type: "text" as const,
                    text: "Execution exe_live saved notebook values: answer. Reply with the word done.",
                  },
                ],
              ]
            : []
        if (identity.id !== undefined)
          expect(await sdk.inspect(dir.path, identity.id, signal)).toBe(identity.checkpoint)
        await sdk.run({
          directory: dir.path,
          model: process.env[`OCPP_EXTERNAL_LIVE_${provider.toUpperCase()}_MODEL`] ?? models[provider],
          history: [],
          harness: {
            type: "ocpp",
            system:
              "You are testing the OC++ harness. Your only tool is `execute`, which runs a JavaScript program such as `const answer = 42`. Keep replies to one word.",
          },
          message: [
            {
              type: "text",
              text:
                round === 1
                  ? "Call execute once with the code `const answer = 42`, then wait for its notification."
                  : "Reply with the word again.",
            },
          ],
          gateway,
          signal,
          vendorSessionID: identity.id,
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
          next: async () => queue.shift(),
          idle: () => {},
        })
        expect(identity.id).toBeString()
        expect(identity.checkpoint).toBeString()
        if (round === 1) {
          expect(calls.some((code) => code.includes("42"))).toBe(true)
          expect(events.some((event) => event.type === "tool-start" && event.name.endsWith("execute"))).toBe(true)
        }
      }
    },
    400_000,
  )
