export * as SubagentCustomTool from "./subagent-custom.js"

import { isToolHandle, type ToolHandle } from "@opencode-ai/codemode"
import { Tool } from "@opencode-ai/schema/tool"
import { Effect, JsonSchema, Schema, SchemaRepresentation } from "effect"

export const JSONSchema = Schema.Record(Schema.String, Schema.Json)

export const validate = Effect.fn("SubagentCustomTool.validate")(function* (values: ReadonlyArray<unknown>) {
  const names = new Set<string>()
  const handles: Array<ToolHandle> = []
  for (const value of values) {
    if (!isToolHandle(value))
      return yield* new Tool.Error({ message: "Subagent tools must be tool.define(...) handles" })
    if (value.definition.name === "execute" || value.definition.name === "submit_result")
      return yield* new Tool.Error({ message: "Custom tool name is reserved: " + value.definition.name })
    if (names.has(value.definition.name))
      return yield* new Tool.Error({ message: "Duplicate custom tool: " + value.definition.name })
    names.add(value.definition.name)
    yield* compile("custom tool " + value.definition.name, "inputSchema", value.definition.inputSchema)
    yield* compile("custom tool " + value.definition.name, "outputSchema", value.definition.outputSchema)
    handles.push(value)
  }
  return handles
})

/** Compiles a caller-supplied JSON Schema into the codec that validates values against it. */
export const validateSchema = (
  name: string,
  schema: typeof JSONSchema.Type,
  field: "inputSchema" | "outputSchema" = "outputSchema",
) => compile(name, field, schema)

export function make(handles: ReadonlyArray<ToolHandle>): ReadonlyArray<Tool.Info> {
  return handles.map((handle) => ({
    name: handle.definition.name,
    description: handle.definition.description,
    input: codec(handle.definition.inputSchema),
    output: codec(handle.definition.outputSchema),
    execute: (input) =>
      handle.invoke(input).pipe(
        Effect.map((output) => ({
          output,
          content: typeof output === "string" ? output : (JSON.stringify(output, null, 2) ?? String(output)),
          metadata: {
            executionKind: "custom-tool",
            executionStatus: "completed",
            capabilities: handle.definition.capabilities,
          },
        })),
        Effect.mapError(
          (error) =>
            new Tool.Error({
              message: error instanceof globalThis.Error ? error.message : String(error),
              metadata: {
                executionKind: "custom-tool",
                executionStatus: "error",
                capabilities: handle.definition.capabilities,
              },
            }),
        ),
      ),
  }))
}

function codec(schema: JsonSchema.JsonSchema) {
  const draft =
    (typeof schema.$schema === "string" && schema.$schema.includes("draft-07")) || "definitions" in schema
      ? JsonSchema.fromSchemaDraft07(schema)
      : JsonSchema.fromSchemaDraft2020_12(schema)
  return Schema.make<Schema.Codec<unknown>>(SchemaRepresentation.fromJsonSchemaDocument(draft).ast)
}

function compile(name: string, field: "inputSchema" | "outputSchema", schema: JsonSchema.JsonSchema) {
  return Effect.try({
    try: () => codec(schema),
    catch: (error) => new Tool.Error({ message: "Invalid " + field + " for " + name, error }),
  })
}
