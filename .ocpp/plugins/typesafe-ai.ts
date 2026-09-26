import { TypeSafeClient, type SystemOneRequest } from "@typesafe-ai/sdk"
import { loadEnvFile } from "node:process"
import { Plugin } from "../../packages/plugin/src/promise/index.ts"

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
              criteria: { type: "array", items: Entry, minItems: 2 },
            },
          },
        ],
      },
    },
    model: { type: "string", description: "Optional TypeSafe model override" },
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

let client: TypeSafeClient | undefined
let credentialsLoaded = false
const getClient = () => {
  if (!credentialsLoaded) {
    loadEnvFile("/Users/devagr/.config/ocpp/typesafe-ai.env")
    credentialsLoaded = true
  }
  return (client ??= new TypeSafeClient())
}

export default Plugin.define({
  id: "typesafe-ai",
  async setup(ctx) {
    await ctx.tool.transform((tools) => {
      tools.add({
        name: "systemOne",
        options: { namespace: "jev" },
        description:
          "Run TypeSafe System One over named noul, choice, and score questions. Returns the SDK result unchanged.",
        input: SystemOneInput,
        output: SystemOneOutput,
        execute: async (input) => {
          const output = await getClient().systemOne(input as SystemOneRequest)
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
          const output = await getClient().models.list()
          return { output, content: JSON.stringify(output, null, 2) }
        },
      })
    })
  },
})
