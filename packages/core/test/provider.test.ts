import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Provider } from "@ocpp/core/provider"

describe("Provider", () => {
  test("loads bundled native provider entrypoints", async () => {
    const packages = [
      "@ocpp/ai/providers/cerebras",
      "@ocpp/ai/providers/deepinfra",
      "@ocpp/ai/providers/google-vertex",
      "@ocpp/ai/providers/google-vertex/gemini",
      "@ocpp/ai/providers/google-vertex/chat",
      "@ocpp/ai/providers/google-vertex/responses",
      "@ocpp/ai/providers/google-vertex/messages",
      "@ocpp/ai/providers/groq",
      "@ocpp/ai/providers/mistral",
      "@ocpp/ai/providers/togetherai",
    ]

    for (const specifier of packages) {
      const loaded = await Effect.runPromise(Provider.loadPackage(specifier))
      expect(loaded.model).toBeFunction()
    }
  })
})
