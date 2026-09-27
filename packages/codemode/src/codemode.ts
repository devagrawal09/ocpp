import { Effect, Schema } from "effect"
import type { Program } from "./ir.js"
import type { NotebookValue } from "./interpreter/durable.js"
import { executeWithLimits } from "./interpreter/execute.js"
import { type Services, type ToolDescription, ToolRuntime } from "./tool-runtime.js"
import type { Tools } from "./tools.js"
import type { TraceHook } from "./trace.js"

/** A tool call admitted during an execution. */
export type { ToolCall, ToolCallEnded, ToolCallHooks, ToolCallStarted, ToolDescription } from "./tool-runtime.js"
export type { TraceEvent, TraceHook } from "./trace.js"
/** Signature-construction helpers for host-owned catalog instructions. */
export { searchSignature, toolExpression } from "./tool-runtime.js"

/** Resource budgets enforced independently during each CodeMode program execution. */
export type ExecutionLimits = {
  /**
   * Wall-clock milliseconds before the activation and any in-flight tool call are interrupted.
   * No default: absent means no timeout.
   */
  readonly timeoutMs?: number
  /** Maximum number of tool calls admitted by the runtime. No default: absent means unlimited. */
  readonly maxToolCalls?: number
  /**
   * Maximum UTF-8 bytes retained from the preview and logs. Warnings have a separate equal budget;
   * truncation notices and host formatting are additional.
   */
  readonly maxOutputBytes?: number
  /** Maximum UTF-8 bytes retained from captured console logs. Defaults to maxOutputBytes. */
  readonly maxLogBytes?: number
  /** Maximum encoded UTF-8 bytes of one durable notebook value. Absent means unlimited. */
  readonly maxDeclarationBytes?: number
}

export type ResolvedExecutionLimits = {
  readonly timeoutMs: number | undefined
  readonly maxToolCalls: number | undefined
  readonly maxOutputBytes: number | undefined
  readonly maxLogBytes: number | undefined
  readonly maxDeclarationBytes: number | undefined
}

/** Options for one CodeMode execution. */
export type ExecuteOptions<Provided extends Record<string, unknown> = {}> = {
  /** Source for one program in the supported JavaScript subset. */
  code: string
  /** Explicit tools exposed to the program as `tools`. */
  tools?: Provided & Tools<Services<Provided>>
  /** Immutable notebook values visible to this execution, as saved by earlier executions. */
  bindings?: Readonly<Record<string, NotebookValue>>
  /** Invocation-local machine input exposed directly as `input` without becoming a notebook binding. */
  input?: DataValue
  /** Precompiled program. Hosts persist this with its version for resumable activations. */
  program?: Program
  /** Per-execution overrides for the default resource limits. */
  limits?: ExecutionLimits
  /** Observes decoded tool input immediately before tool execution. */
  onToolCallStart?: (call: ToolRuntime.ToolCallStarted) => Effect.Effect<void, never, Services<Provided>>
  /** Observes each admitted tool call as it succeeds, fails, or is interrupted. */
  onToolCallEnd?: (call: ToolRuntime.ToolCallEnded) => Effect.Effect<void, never, Services<Provided>>
  /** Observes semantic JavaScript steps in execution order. */
  onTrace?: TraceHook<Services<Provided>>
}

/** A JSON value that can cross the confined interpreter boundary. */
export type DataValue = Schema.Json

export type { NotebookValue } from "./interpreter/durable.js"
export { isFunctionValue } from "./interpreter/durable.js"

/** Configuration shared by `CodeMode.make` and `CodeMode.execute`. */
export type Options<Provided extends Record<string, unknown> = {}> = Omit<ExecuteOptions<Provided>, "code">

/** Schema for a host tool input containing CodeMode source. */
export const Input = Schema.Struct({ code: Schema.String })
export type Input = typeof Input.Type

export const DiagnosticKind = Schema.Literals([
  "ParseError",
  "UnsupportedSyntax",
  "UnknownTool",
  "InvalidToolInput",
  "InvalidToolOutput",
  "InvalidDataValue",
  "InvalidDurableValue",
  "ToolCallLimitExceeded",
  "TimeoutExceeded",
  "ToolFailure",
  "ExecutionFailure",
  "Compatibility",
  "Truncated",
])
/** Stable categories produced by program, schema, tool, limit, and truncation diagnostics. */
export type DiagnosticKind = typeof DiagnosticKind.Type

export const Diagnostic = Schema.Struct({
  kind: DiagnosticKind,
  message: Schema.String,
  location: Schema.optionalKey(Schema.Struct({ line: Schema.Number, column: Schema.Number })),
  /** The trimmed source line at `location`, present for parse failures. */
  excerpt: Schema.optionalKey(Schema.String),
  suggestions: Schema.optionalKey(Schema.Array(Schema.String)),
})
/** A normalized program diagnostic safe to return across an agent tool boundary. */
export type Diagnostic = typeof Diagnostic.Type

const ToolCallSchema = Schema.Struct({ name: Schema.String })
export const Success = Schema.Struct({
  ok: Schema.Literal(true),
  /** Optional display preview of the returned value. Notebook declarations carry the real output. */
  value: Schema.Json,
  warnings: Schema.optionalKey(Schema.Array(Diagnostic)),
  logs: Schema.optionalKey(Schema.Array(Schema.String)),
  truncated: Schema.optionalKey(Schema.Boolean),
  toolCalls: Schema.Array(ToolCallSchema),
  /** Durable values the program declared at the top level, ready for the host to save. */
  declarations: Schema.Record(Schema.String, Schema.Json),
})
/** Successful execution after the result has crossed the plain-data boundary. */
export type Success = typeof Success.Type

export const Failure = Schema.Struct({
  ok: Schema.Literal(false),
  error: Diagnostic,
  logs: Schema.optionalKey(Schema.Array(Schema.String)),
  truncated: Schema.optionalKey(Schema.Boolean),
  toolCalls: Schema.Array(ToolCallSchema),
})
/** Failed execution with calls admitted before the diagnostic was produced. */
export type Failure = typeof Failure.Type

/** Schema for the structured success or diagnostic returned by CodeMode execution. */
export const Result = Schema.Union([Success, Failure])
/** Result of executing a CodeMode program. Program failures are data, not Effect failures. */
export type Result = typeof Result.Type

/** Reusable confined runtime over explicit tools. */
export type Runtime<R = never> = {
  readonly catalog: () => ReadonlyArray<ToolDescription>
  readonly execute: (code: string) => Effect.Effect<Result, never, R>
  readonly executeCompiled: (program: Program) => Effect.Effect<Result, never, R>
}

export { compile, CompileError } from "./compiler.js"
export { decodeProgram, IR_VERSION, type DecodedProgram, type Program } from "./ir.js"

const validateLimit = (name: keyof ExecutionLimits, value: number | undefined, minimum: number): number | undefined => {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < minimum)) {
    throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}.`)
  }
  return value
}

const resolveExecutionLimits = (limits?: ExecutionLimits): ResolvedExecutionLimits => ({
  timeoutMs: validateLimit("timeoutMs", limits?.timeoutMs, 1),
  maxToolCalls: validateLimit("maxToolCalls", limits?.maxToolCalls, 0),
  maxOutputBytes: validateLimit("maxOutputBytes", limits?.maxOutputBytes, 0),
  maxLogBytes: validateLimit("maxLogBytes", limits?.maxLogBytes, 0),
  maxDeclarationBytes: validateLimit("maxDeclarationBytes", limits?.maxDeclarationBytes, 1),
})

/** Executes one Effect-native CodeMode program without constructing a reusable runtime. */
export const execute = <const Provided extends Record<string, unknown>>(
  options: ExecuteOptions<Provided>,
): Effect.Effect<Result, never, Services<Provided>> => {
  const tools = (options.tools ?? {}) as Tools<Services<Provided>>
  return executeWithLimits(options, resolveExecutionLimits(options.limits), ToolRuntime.searchIndex(tools))
}

/** Creates an Effect-native runtime over explicit, schema-described tools. */
export const make = <const Provided extends Record<string, unknown> = {}>(
  options: Options<Provided> = {} as Options<Provided>,
): Runtime<Services<Provided>> => {
  const tools = (options.tools ?? {}) as Tools<Services<Provided>>
  const limits = resolveExecutionLimits(options.limits)
  const prepared = ToolRuntime.prepare(tools)

  return {
    catalog: () => prepared.catalog,
    execute: (code) => executeWithLimits<Provided>({ ...options, code }, limits, prepared.searchIndex),
    executeCompiled: (program) =>
      executeWithLimits<Provided>({ ...options, code: program.source, program }, limits, prepared.searchIndex),
  }
}
