export * as SubagentCustomTool from "./subagent-custom.js"

import { isToolHandle, isToolReference, normalizeError, type ToolHandle } from "@ocpp/codemode"
import { Tool } from "@ocpp/schema/tool"
import { Effect, JsonSchema, Schema, SchemaRepresentation } from "effect"

export const JSONSchema = Schema.Record(Schema.String, Schema.Json)

/**
 * The tools a subagent call hands its child. A tool reference expands through the caller's catalog: the Location's
 * own tools become paths the child keeps, and tools the caller only borrows, such as its tool.define handles and
 * init.ts wrappers, are lent to the child for this call, like the call's own handles.
 */
export const select = Effect.fn("SubagentCustomTool.select")(function* (
  values: ReadonlyArray<unknown>,
  catalog: NonNullable<Tool.Context["catalog"]>,
) {
  const handles = yield* validate(values.filter((value) => !isToolReference(value)))
  const matched = values.filter(isToolReference).map((reference) => {
    const path = reference.path.join(".")
    return {
      path,
      entries: Array.from(catalog).filter(([candidate]) => candidate === path || candidate.startsWith(path + ".")),
    }
  })
  // tools.search is built into every execution, so passing it hands on nothing.
  const unknown = matched.find((item) => item.entries.length === 0 && item.path !== "search")
  if (unknown !== undefined)
    return yield* new Tool.Error({
      message: `tools.${unknown.path} is not one of your tools; a subagent can be given only tools you have.`,
    })
  const entries = Array.from(new Map(matched.flatMap((item) => item.entries)))
  return {
    paths: entries.flatMap(([path, entry]) => (entry.lent ? [] : [path])).toSorted(),
    lent: [...entries.flatMap(([, entry]) => (entry.lent ? [entry.tool] : [])), ...make(handles)],
  }
})

export const validate = Effect.fn("SubagentCustomTool.validate")(function* (values: ReadonlyArray<unknown>) {
  const names = new Set<string>()
  const handles: Array<ToolHandle> = []
  for (const value of values) {
    if (!isToolHandle(value))
      return yield* new Tool.Error({
        message:
          "Tools must be tool references such as tools.read, namespaces such as tools.linear, or tool.define(...) handles",
      })
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
              // A handle fails with Code Mode values, such as an error it throws, as well as host errors.
              message: normalizeError(error).message,
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
