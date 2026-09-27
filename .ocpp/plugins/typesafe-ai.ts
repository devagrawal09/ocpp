import type { Plugin } from "../../packages/plugin/src/promise/index.ts"

// TypeSafe's REST API: POST /v1/systemone and GET /v1/models with a bearer key.
// TYPESAFE_BASE_URL overrides the API origin, for example to point at a local mock.
const integrationID = "typesafe"
const defaultModel = "jev-latest"

const Entry = {
  anyOf: [
    { type: "string" },
    { type: "object", additionalProperties: true },
    { type: "array", items: {} },
    { type: "null" },
  ],
} as const

const SystemOneInput = {
  type: "object",
  additionalProperties: false,
  required: ["state", "questions"],
  properties: {
    state: { ...Entry, description: "Text or structured JSON state to evaluate" },
    questions: {
      type: "object",
      description: "Named noul, choice, or score questions",
      minProperties: 1,
      additionalProperties: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["type"],
            properties: {
              type: { const: "noul" },
              instructions: Entry,
              criteria: {
                anyOf: [
                  { type: "null" },
                  {
                    type: "object",
                    additionalProperties: false,
                    properties: { true: Entry, false: Entry },
                  },
                ],
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "criteria"],
            properties: {
              type: { const: "choice" },
              instructions: Entry,
              criteria: { type: "object", additionalProperties: Entry },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["type", "criteria"],
            properties: {
              type: { const: "score" },
              instructions: Entry,
              criteria: { type: "array", items: Entry, minItems: 2, maxItems: 10 },
            },
          },
        ],
      },
    },
    model: { type: "string", description: `TypeSafe model; defaults to ${defaultModel}` },
  },
} as const

const SystemOneOutput = {
  type: "object",
  additionalProperties: false,
  required: ["model", "answers", "usage"],
  properties: {
    model: { type: "string" },
    answers: {
      type: "object",
      additionalProperties: {
        oneOf: [
          {
            type: "object",
            required: ["type", "noul"],
            properties: { type: { const: "noul" }, noul: { type: "number" } },
          },
          {
            type: "object",
            required: ["type", "choice", "confidence", "probabilities"],
            properties: {
              type: { const: "choice" },
              choice: { type: "string" },
              confidence: { type: "number" },
              probabilities: { type: "object", additionalProperties: { type: "number" } },
            },
          },
          {
            type: "object",
            required: ["type", "score", "confidence", "legend", "probabilities"],
            properties: {
              type: { const: "score" },
              score: { type: "number" },
              confidence: { type: "number" },
              legend: { type: "object", additionalProperties: Entry },
              probabilities: { type: "object", additionalProperties: { type: "number" } },
            },
          },
        ],
      },
    },
    usage: {
      type: "object",
      additionalProperties: false,
      required: ["input_tokens", "output_tokens"],
      properties: { input_tokens: { type: "number" }, output_tokens: { type: "number" } },
    },
  },
} as const

const ModelsOutput = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["name", "description", "release_date"],
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      release_date: { type: "string" },
    },
  },
} as const

export default {
  id: "typesafe-ai",
  async setup(ctx) {
    // The integration resolves an API key saved through OC++ first, then TYPESAFE_API_KEY.
    await ctx.integration.transform((draft) => {
      draft.update(integrationID, (integration) => {
        integration.name = "TypeSafe"
      })
      draft.method.update({ integrationID, method: { type: "key", label: "API key" } })
      draft.method.update({ integrationID, method: { type: "env", names: ["TYPESAFE_API_KEY"] } })
    })

    const request = async (method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> => {
      const connection = await ctx.integration.connection.active(integrationID)
      const credential = connection && (await ctx.integration.connection.resolve(connection))
      if (credential?.type !== "key")
        throw new Error(
          "TypeSafe API key is not configured. Set the TYPESAFE_API_KEY environment variable for the OC++ server, or connect the TypeSafe integration with an API key.",
        )
      const url = `${(process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(/\/+$/, "")}${path}`
      const response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${credential.key}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      }).catch((error) => {
        throw new Error(`TypeSafe ${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      const retry = response.headers.get("retry-after")
      if (response.status === 429)
        throw new Error(
          `TypeSafe rate limit reached (HTTP 429)${retry ? `; retry after ${/^\d+$/.test(retry) ? `${retry} seconds` : retry}` : ""}.`,
        )
      if (!response.ok) {
        const text = (await response.text()).trim()
        throw new Error(
          `TypeSafe ${method} ${path} failed with HTTP ${response.status}${text ? `: ${text.slice(0, 1_000)}` : ""}`,
        )
      }
      return response.json()
    }

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "systemOne",
        options: { namespace: "jev" },
        description: [
          "Answer typed questions about a state with TypeSafe System One (Jev) and return probabilities.",
          "Each named question is a noul (answer.noul is P(yes)), a choice (answer.choice is the chosen criteria label, with confidence and per-label probabilities), or a score (2 to 10 rubric levels in criteria; answer.score is the expected level, with confidence, legend, and probabilities).",
          `Questions in one call are answered together, so batch them. The model defaults to ${defaultModel}.`,
          "Jev never abstains: compare confidence against your own threshold and escalate uncertain answers.",
        ].join("\n"),
        input: SystemOneInput,
        output: SystemOneOutput,
        execute: async (input) => {
          // Core validates tool input against SystemOneInput before execution.
          const body = input as { readonly model?: string }
          const output = await request("POST", "/v1/systemone", { ...body, model: body.model ?? defaultModel })
          return { output, content: JSON.stringify(output, null, 2) }
        },
      })

      tools.add({
        name: "list",
        options: { namespace: "jev.models" },
        description: "List the TypeSafe models available to the configured account.",
        input: { type: "object", additionalProperties: false },
        output: ModelsOutput,
        execute: async () => {
          const body = await request("GET", "/v1/models")
          const output = typeof body === "object" && body !== null && "models" in body ? body.models : undefined
          if (!Array.isArray(output)) throw new Error("TypeSafe returned a models response without a models list.")
          return { output, content: JSON.stringify(output, null, 2) }
        },
      })
    })
  },
} satisfies Plugin.Plugin
