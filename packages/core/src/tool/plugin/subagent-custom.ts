export * as SubagentCustomTool from "./subagent-custom.js"

import { CodeModeExecution } from "@opencode-ai/schema/codemode-execution"
import type { CodeMode } from "@opencode-ai/codemode"
import { Tool } from "@opencode-ai/schema/tool"
import { Effect, JsonSchema, Schema, SchemaRepresentation } from "effect"
import { definition, execute, normalizedName } from "../runtime.js"

export const JSONSchema = Schema.Record(Schema.String, Schema.Json)

export const Definition = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/)),
  description: Schema.String,
  inputSchema: JSONSchema,
  outputSchema: JSONSchema,
  code: Schema.String.check(Schema.isMinLength(1)),
  values: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
  timeoutMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
})
export type Definition = typeof Definition.Type

export const validate = Effect.fn("SubagentCustomTool.validate")(function* (definitions: ReadonlyArray<Definition>) {
  const names = new Set<string>()
  const codemode = yield* Effect.promise(() => import("@opencode-ai/codemode"))
  for (const item of definitions) {
    if (item.name === "execute" || item.name === "submit_result")
      return yield* new Tool.Error({ message: `Custom tool name is reserved: ${item.name}` })
    if (names.has(item.name)) return yield* new Tool.Error({ message: `Duplicate custom tool: ${item.name}` })
    names.add(item.name)
    yield* compile(item.name, "inputSchema", item.inputSchema)
    yield* compile(item.name, "outputSchema", item.outputSchema)
    const result = yield* codemode.CodeMode.execute({
      code: source(item.code, {}, item.values),
      limits: { timeoutMs: 10, maxToolCalls: 0 },
    })
    if (!result.ok && (result.error.kind === "ParseError" || result.error.kind === "UnsupportedSyntax"))
      return yield* new Tool.Error({ message: `Invalid custom tool code for ${item.name}: ${result.error.message}` })
  }
})

export const validateSchema = (name: string, schema: typeof JSONSchema.Type) => compile(name, "outputSchema", schema)

export function make(
  definitions: ReadonlyArray<Definition>,
  parentTools: ReadonlyArray<Tool.Info>,
  parentContext: Tool.Context,
): ReadonlyArray<Tool.Info> {
  return definitions.map((item) => ({
    name: item.name,
    description: item.description,
    input: item.inputSchema,
    output: item.outputSchema,
    execute: (input, context) => run(item, input, parentTools, parentContext, context),
  }))
}

function run(
  item: Definition,
  input: unknown,
  parentTools: ReadonlyArray<Tool.Info>,
  parentContext: Tool.Context,
  context: Tool.Context,
) {
  return Effect.gen(function* () {
    const codemode = yield* Effect.promise(() => import("@opencode-ai/codemode"))
    const events: Array<CodeModeExecution.ToolEvent> = []
    const visible = () => events.filter((event) => event !== undefined)
    const progress = (status: "running" | "completed" | "error") =>
      context.progress({ executionKind: "custom-tool", executionStatus: status, events: visible() })
    const tools = Object.fromEntries(
      parentTools.map((registration) => {
        const child = definition(registration)
        const path =
          registration.options?.namespace === undefined
            ? normalizedName(registration)
            : `${registration.options.namespace}.${normalizedName(registration)}`
        return [
          path,
          codemode.Tool.make({
            description: child.description,
            input: child.inputSchema,
            output: child.outputSchema ?? Schema.NullOr(Schema.String),
            execute: (value, call) =>
              call
                ? execute(registration, value, {
                    ...parentContext,
                    progress: (metadata) => {
                      const current = events[call.index]
                      if (current) events[call.index] = { ...current, metadata: jsonRecord(metadata) }
                      return progress("running")
                    },
                  }).pipe(
                    Effect.map((result) => {
                      const content =
                        typeof result.content === "string"
                          ? result.content
                          : (result.content ?? [])
                              .flatMap((part) => (part.type === "text" ? [part.text] : []))
                              .join("\n")
                      return result.output ?? (content || null)
                    }),
                  )
                : Effect.fail(new Tool.Error({ message: "Custom tool call context is unavailable" })),
          }),
        ] as const
      }),
    )
    const result = yield* codemode.CodeMode.make({
      tools,
      limits: { timeoutMs: item.timeoutMs },
      onToolCallStart: ({ index, name, input }) =>
        Effect.sync(() => {
          const shown = jsonRecord(input)
          events[index] = {
            type: "tool",
            tool: name,
            status: "running",
            ...(shown ? { input: shown } : {}),
          }
        }).pipe(Effect.andThen(progress("running"))),
      onToolCallEnd: ({ index, name, input, outcome, output, message }) =>
        Effect.sync(() => {
          const current = events[index] ?? { type: "tool" as const, tool: name, status: "running" as const }
          const shown = jsonRecord(input)
          events[index] =
            outcome === "success"
              ? {
                  ...current,
                  status: "completed",
                  ...(display(output) ? { output: display(output) } : {}),
                  ...(current.input === undefined && shown ? { input: shown } : {}),
                }
              : { ...current, status: "error", error: message ?? "Tool execution interrupted" }
        }).pipe(Effect.andThen(progress(outcome === "success" ? "running" : "error"))),
    }).execute(source(item.code, input, item.values))
    if (!result.ok)
      return yield* new Tool.Error({
        message: format(result),
        metadata: { executionKind: "custom-tool", executionStatus: "error", events: visible() },
      })
    yield* validateOutput(item, result.value, parentContext)
    return {
      output: result.value,
      content: format(result),
      metadata: { executionKind: "custom-tool", executionStatus: "completed", events: visible() },
    }
  })
}

function validateOutput(item: Definition, value: unknown, context: Tool.Context) {
  return execute(
    {
      name: item.name,
      description: item.description,
      input: item.outputSchema,
      execute: () => Effect.succeed({}),
    },
    value,
    context,
  ).pipe(Effect.asVoid)
}

function compile(name: string, field: "inputSchema" | "outputSchema", schema: typeof JSONSchema.Type) {
  return Effect.try({
    try: () => {
      const draft =
        (typeof schema.$schema === "string" && schema.$schema.includes("draft-07")) || "definitions" in schema
          ? JsonSchema.fromSchemaDraft07(schema)
          : JsonSchema.fromSchemaDraft2020_12(schema)
      Schema.make(SchemaRepresentation.fromJsonSchemaDocument(draft).ast)
    },
    catch: (error) => new Tool.Error({ message: `Invalid ${field} for custom tool ${name}`, error }),
  })
}

function source(code: string, input: unknown, values: Definition["values"]) {
  return `const input = ${JSON.stringify(input)};\nconst values = ${JSON.stringify(values ?? {})};\n${code}`
}

function format(result: CodeMode.Result) {
  const value = result.ok
    ? typeof result.value === "string"
      ? result.value
      : (JSON.stringify(result.value, null, 2) ?? String(result.value))
    : result.error.message
  const warnings =
    result.ok && result.warnings?.length
      ? `Warnings:\n${result.warnings.map((warning) => `- [${warning.kind}] ${warning.message}`).join("\n")}`
      : undefined
  const logs = result.logs?.length ? `Logs:\n${result.logs.join("\n")}` : undefined
  return [value, warnings, logs].filter((part) => part).join("\n\n")
}

function jsonRecord(value: unknown): Record<string, typeof Schema.Json.Type> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, typeof Schema.Json.Type>
}

function display(value: unknown) {
  if (value === undefined) return
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2) ?? String(value)
}
