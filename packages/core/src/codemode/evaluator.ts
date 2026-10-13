export * as CodeModeEvaluator from "./evaluator.js"

import { CodeMode } from "@ocpp/codemode"
import { Tool } from "@ocpp/schema/tool"
import { Effect, Schema } from "effect"
import { effectiveName } from "../tool/runtime.js"
import { CodeModeCompileCheck } from "./compile-check.js"
import { CodeModeTool } from "./tool.js"

const Input = Schema.Struct({
  code: Schema.String,
  input: Schema.Json.pipe(Schema.optionalKey),
  tools: Schema.Array(Schema.String).pipe(Schema.optionalKey),
  maxToolCalls: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 16 })).pipe(Schema.optionalKey),
})

const Output = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), value: Schema.Json, toolCalls: CodeMode.Success.fields.toolCalls }),
  CodeMode.Failure,
])

/** Nested programs use the same gateway as their calling execution, over an explicit tool subset. */
export function tool(
  invoke: (
    name: string,
    tool: Tool.Info,
    input: unknown,
    context: Tool.Context,
  ) => Effect.Effect<Tool.Result, Tool.Error>,
) {
  return {
    name: "evaluate",
    options: { namespace: "capability", acceptsToolHandles: true },
    description:
      "Compile and run source over an explicit subset of your tools. Pass tool paths without the tools. prefix. Input is available as input. Returns a value or diagnostic; declarations are not installed in the notebook. No native eval or ambient filesystem/network access.",
    input: Input,
    output: Output,
    execute: Effect.fn("CodeModeEvaluator.evaluate")(function* (input: typeof Input.Type, context: Tool.Context) {
      const paths = input.tools ?? []
      const missing = paths.find((path) => !context.catalog?.has(path))
      if (missing !== undefined)
        return yield* new Tool.Error({ message: "tools." + missing + " is not available to this execution." })
      const catalog = new Map(
        paths.flatMap((path) => {
          const entry = context.catalog?.get(path)
          return entry ? [[path, entry] as const] : []
        }),
      )
      const registrations = new Map(Array.from(catalog.values(), (entry) => [effectiveName(entry.tool), entry.tool]))
      // Nested declarations are activation-local, not notebook bindings to serialize.
      const code = "{\n" + input.code + "\n}"
      const program = yield* Effect.try({
        try: () => CodeMode.compile(code),
        catch: (error) =>
          error instanceof CodeMode.CompileError
            ? CodeModeCompileCheck.compileFailure(error, code)
            : new Tool.Error({ message: String(error) }),
      })
      const unavailable = CodeModeCompileCheck.unavailableTools(program, code, paths)
      if (unavailable) return yield* unavailable
      const result = yield* Effect.scoped(
        CodeMode.evaluate({
          code,
          program,
          input: input.input,
          tools: CodeModeTool.tools(registrations, (name, tool, value, index) =>
            invoke(name, tool, value, {
              ...context,
              catalog,
              id: Tool.CallID.make(context.id + ":" + index),
              progress: () => Effect.void,
            }).pipe(
              Effect.map((result) =>
                result.output === undefined
                  ? typeof result.content === "string"
                    ? result.content
                    : (result.content ?? []).flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
                  : result.output,
              ),
            ),
          ),
          limits: { timeoutMs: 60_000, maxToolCalls: input.maxToolCalls ?? 16, maxOutputBytes: 65_536 },
        }),
      )
      if (!result.ok) return { output: result, content: JSON.stringify(result) }
      const value = yield* Schema.decodeUnknownEffect(Schema.Json)(result.value ?? null).pipe(
        Effect.mapError((error) => new Tool.Error({ message: error.message })),
      )
      const output = { ok: true as const, value, toolCalls: result.toolCalls }
      return { output, content: JSON.stringify(output) }
    }),
  } satisfies Tool.Info<typeof Input, typeof Output>
}
