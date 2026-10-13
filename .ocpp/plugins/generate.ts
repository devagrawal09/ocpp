import type { Plugin } from "../../packages/plugin/src/promise/index.ts"

// One LLM call that writes code (or text) and returns. No tools, no execute loop, no session:
// the caller supplies the brief and every piece of context it wants the model to see.
const Entry = {
  anyOf: [{ type: "string" }, { type: "object", additionalProperties: true }, { type: "array", items: {} }],
} as const

const ModelRef = {
  type: "object",
  additionalProperties: false,
  required: ["providerID", "id"],
  properties: {
    providerID: { type: "string" },
    id: { type: "string" },
    variant: { type: "string" },
  },
  description: "Model to use; defaults to the session's model",
} as const

const CodeInput = {
  type: "object",
  additionalProperties: false,
  required: ["brief"],
  properties: {
    brief: { type: "string", description: "What the code must do, including its exact exported shape or signature" },
    language: { type: "string", description: "Target language; defaults to TypeScript" },
    context: {
      ...Entry,
      description: "Deterministically gathered context: types, signatures, examples, state shapes, failures",
    },
    constraints: { type: "array", items: { type: "string" }, description: "Rules the code must follow" },
    model: ModelRef,
  },
} as const

const CodeOutput = {
  type: "object",
  additionalProperties: false,
  required: ["code", "language"],
  properties: { code: { type: "string" }, language: { type: "string" } },
} as const

const TextInput = {
  type: "object",
  additionalProperties: false,
  required: ["prompt"],
  properties: {
    prompt: { type: "string", description: "The complete prompt; nothing else is added" },
    model: ModelRef,
  },
} as const

const TextOutput = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: { text: { type: "string" } },
} as const

/** Returns the body of the first fenced block, or the whole text when there is no fence. */
function unfence(text: string): string {
  const trimmed = text.trim()
  const open = trimmed.indexOf("```")
  if (open < 0) return trimmed
  const bodyStart = trimmed.indexOf("\n", open)
  if (bodyStart < 0) return trimmed
  const close = trimmed.indexOf("\n```", bodyStart)
  return (close < 0 ? trimmed.slice(bodyStart + 1) : trimmed.slice(bodyStart + 1, close)).trim()
}

function render(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2)
}

type Ref = { readonly providerID: string; readonly id: string; readonly variant?: string }

export default {
  id: "generate",
  async setup(ctx) {
    // Explicit model, else the calling session's model, else the global default. The global default is
    // whatever the user configured and may be stale; a session's model is what they are actually using.
    const resolve = async (explicit: Ref | undefined, sessionID: string): Promise<{ model?: Ref }> => {
      if (explicit) return { model: explicit }
      const session = await ctx.session.get({ sessionID: sessionID as never }).catch(() => undefined)
      const model = (session as { readonly model?: Ref } | undefined)?.model
      return model ? { model } : {}
    }

    await ctx.tool.transform((tools) => {
      tools.add({
        name: "code",
        options: { namespace: "generate", readOnly: true },
        description: [
          "Write code with a single LLM call and return it. The model gets no tools and runs no loop:",
          "put every type, signature, example and failure the code must respect into context, deterministically.",
          "Use it as the authoring step of a decision-first loop: code gathers the brief, the decision model judges the result.",
          "Returns the code with any markdown fence removed; nothing is executed or saved.",
        ].join("\n"),
        input: CodeInput,
        output: CodeOutput,
        execute: async (input, context) => {
          const body = input as {
            readonly brief: string
            readonly language?: string
            readonly context?: unknown
            readonly constraints?: readonly string[]
            readonly model?: Ref
          }
          const language = body.language ?? "TypeScript"
          const prompt = [
            `Write ${language} code that does exactly what the brief asks. Output only the code, in one fenced block, with no explanation before or after.`,
            "Do not invent APIs that the context does not show. Match the exported shape or signature the brief names exactly.",
            ...(body.constraints?.length ? ["Constraints:", ...body.constraints.map((c) => "- " + c)] : []),
            ...(body.context === undefined ? [] : ["Context:", render(body.context)]),
            "Brief:",
            body.brief,
          ].join("\n\n")
          const { text } = await ctx.generate.text({ prompt, ...(await resolve(body.model, context.sessionID)) })
          const output = { code: unfence(text), language }
          return { output, content: output.code }
        },
      })

      tools.add({
        name: "text",
        options: { namespace: "generate", readOnly: true },
        description: "Complete one prompt with a single LLM call and return the text. No tools, no loop, no session history.",
        input: TextInput,
        output: TextOutput,
        execute: async (input, context) => {
          const body = input as {
            readonly prompt: string
            readonly model?: Ref
          }
          const { text } = await ctx.generate.text({ prompt: body.prompt, ...(await resolve(body.model, context.sessionID)) })
          return { output: { text }, content: text }
        },
      })
    })
  },
} satisfies Plugin.Plugin
