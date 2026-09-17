export * as ExternalAgentGateway from "./gateway.js"

import { CodeMode, Tool } from "@opencode-ai/codemode"
import { Effect, Schema, Semaphore } from "effect"
import { SubagentCustomTool } from "../tool/plugin/subagent-custom.js"

export interface Definition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Record<string, Schema.Json>
}
export interface Submission {
  readonly message: string
  readonly output: Schema.Json
}
export interface Gateway {
  readonly definitions: ReadonlyArray<Definition>
  readonly invoke: (name: string, input: unknown) => Effect.Effect<unknown, unknown>
  readonly result: () => Submission | undefined
  readonly close: () => void
}

/** The only boundary that invokes delegated handles. SDK adapters never receive the handles or private input. */
export const make = Effect.fn("ExternalAgentGateway.make")(function* (options: {
  readonly tools?: ReadonlyArray<unknown>
  readonly input?: Schema.Json
  readonly inputSchema?: Record<string, Schema.Json>
  readonly outputSchema?: Record<string, Schema.Json>
}) {
  const handles = yield* SubagentCustomTool.validate(options.tools ?? [])
  const output =
    options.outputSchema === undefined
      ? undefined
      : yield* SubagentCustomTool.validateSchema("result", options.outputSchema)
  if (options.inputSchema !== undefined) {
    const input = yield* SubagentCustomTool.validateSchema("machine input", options.inputSchema, "inputSchema")
    yield* Schema.decodeUnknownEffect(input)(options.input).pipe(
      Effect.mapError(() => new Error("Private input does not match inputSchema")),
    )
  }
  const entries = yield* Effect.forEach(handles, (handle) =>
    Effect.gen(function* () {
      const input = yield* SubagentCustomTool.validateSchema(
        handle.definition.name,
        handle.definition.inputSchema as Record<string, Schema.Json>,
        "inputSchema",
      )
      const output = yield* SubagentCustomTool.validateSchema(
        handle.definition.name,
        handle.definition.outputSchema as Record<string, Schema.Json>,
      )
      return { handle, input, output }
    }),
  )
  const bindings: Record<string, CodeMode.NotebookValue> = {}
  const state: { active: boolean; submitted?: Submission } = { active: true }
  const lock = Semaphore.makeUnsafe(1)
  const definitions: Definition[] = entries
    .filter((entry) => entry.handle.definition.inputSchema.type === "object")
    .map((entry) => ({
      name: entry.handle.definition.name,
      description: entry.handle.definition.description,
      inputSchema: entry.handle.definition.inputSchema as Record<string, Schema.Json>,
    }))
  const submit = Schema.Struct({ message: Schema.String, output: output ?? Schema.Json })
  if (output !== undefined)
    definitions.push({
      name: "submit_result",
      description:
        "Finish with a message for the caller and private structured output. In execute programs call tools.submit_result({ message, output }); output remains machine-only to the caller.",
      inputSchema: {
        type: "object",
        properties: { message: { type: "string" }, output: options.outputSchema! },
        required: ["message", "output"],
        additionalProperties: false,
      },
    })
  const invoke = Effect.fn("ExternalAgentGateway.invoke")(function* (
    name: string,
    value: unknown,
  ): Effect.fn.Return<unknown, unknown> {
    if (!state.active) return yield* Effect.fail(new Error("External tool activation is closed"))
    if (name === "submit_result" && output !== undefined) {
      if (state.submitted !== undefined) return yield* Effect.fail(new Error("A result was already submitted"))
      const decoded = yield* Schema.decodeUnknownEffect(submit)(value).pipe(
        Effect.mapError(() => new Error("Submission does not match outputSchema")),
      )
      const json = yield* Schema.decodeUnknownEffect(Schema.Json)(decoded.output).pipe(
        Effect.mapError(() => new Error("Structured output must be JSON")),
      )
      state.submitted = { message: decoded.message, output: json }
      return "Result submitted."
    }
    if (state.submitted !== undefined) return yield* Effect.fail(new Error("External result was already submitted"))
    if (name === "execute") {
      const input = yield* Schema.decodeUnknownEffect(CodeMode.Input)(value)
      const tools: Record<string, Tool.Tool> = Object.fromEntries(
        entries.map((entry) => [
          entry.handle.definition.name,
          Tool.make({
            description: entry.handle.definition.description,
            input: entry.input,
            output: entry.output,
            execute: (value) => invoke(entry.handle.definition.name, value),
          }),
        ]),
      )
      if (output !== undefined)
        tools.submit_result = Tool.make({
          description: "Submit the required private result.",
          input: submit,
          output: Schema.String,
          execute: (value) => invoke("submit_result", value).pipe(Effect.map(String)),
        })
      const result = yield* CodeMode.execute({
        code: input.code,
        tools,
        input: options.input,
        bindings,
        limits: { maxToolCalls: 100, maxOutputBytes: 16_384, maxLogBytes: 16_384, maxDeclarationBytes: 8_388_608 },
      })
      if (result.ok) Object.assign(bindings, result.declarations)
      // Notebook declarations can contain private input or structured results. Only explicit preview/logs cross to a model.
      return result.ok
        ? { ok: true, value: result.value, logs: result.logs, warnings: result.warnings }
        : { ok: false, error: result.error, logs: result.logs }
    }
    const entry = entries.find((entry) => entry.handle.definition.name === name)
    if (entry === undefined) return yield* Effect.fail(new Error("Unknown external tool: " + name))
    const decoded = yield* Schema.decodeUnknownEffect(entry.input)(value).pipe(
      Effect.mapError(() => new Error("Invalid input for delegated tool " + name)),
    )
    const result = yield* entry.handle.invoke(decoded)
    return yield* Schema.decodeUnknownEffect(entry.output)(result).pipe(
      Effect.mapError(() => new Error("Invalid output from delegated tool " + name)),
    )
  })
  definitions.push({
    name: "execute",
    description:
      "Execute confined JavaScript with private input as `input`, persistent notebook variables, and the provided tools. Assign results to variables to keep them machine-only. Only explicit final expressions and console logs are displayed. " +
      entries
        .map(
          (entry) =>
            `tools.${entry.handle.definition.name}: ${entry.handle.definition.description}\ninputSchema: ${JSON.stringify(entry.handle.definition.inputSchema)}\noutputSchema: ${JSON.stringify(entry.handle.definition.outputSchema)}`,
        )
        .join("\n") +
      "\n" +
      definitions
        .filter((tool) => tool.name === "submit_result")
        .map((tool) => `tools.${tool.name}: ${tool.description}`)
        .join("\n"),
    inputSchema: {
      type: "object",
      properties: { code: { type: "string" } },
      required: ["code"],
      additionalProperties: false,
    },
  })
  return {
    definitions,
    invoke: (name, input) => lock.withPermit(invoke(name, input)),
    result: () => state.submitted,
    close: () => {
      state.active = false
    },
  } satisfies Gateway
})
