import { Cause, Duration, Effect, Scope } from "effect"
import { compile } from "../compiler.js"
import { decodeProgram } from "../ir.js"
import type { DataValue, Diagnostic, Evaluation, ExecuteOptions, ResolvedExecutionLimits, Result } from "../codemode.js"
import { ToolHandle } from "../tool-handle.js"
import { copyIn, copyOut, ToolRuntime, type Services } from "../tool-runtime.js"
import type { Tools } from "../tools.js"
import { defaultDurableLimits, encodeDeclarations } from "./durable.js"
import { normalizeError } from "./errors.js"
import { PromiseRuntime } from "./promises.js"
import { Interpreter } from "./runtime.js"

export const executeWithLimits = <const Provided extends Record<string, unknown>>(
  options: ExecuteOptions<Provided>,
  limits: ResolvedExecutionLimits,
  searchIndex: ToolRuntime.DiscoveryPlan["searchIndex"],
): Effect.Effect<Result, never, Services<Provided>> => {
  if (options.code.trim().length === 0) {
    return Effect.succeed({
      ok: false,
      error: { kind: "ParseError", message: "Code cannot be empty." },
      toolCalls: [],
    })
  }
  // A supplied program may have been persisted by an earlier host, so it is decoded before anything
  // else: the interpreter only ever evaluates a program this boundary accepted.
  const decoded = options.program === undefined ? undefined : decodeProgram(options.program)
  if (decoded?.ok === false) {
    return Effect.succeed({
      ok: false,
      error: { kind: "ExecutionFailure", message: decoded.message },
      toolCalls: [],
    })
  }

  // Allocate execution state inside suspension so reused Effects never share it.
  return Effect.suspend(() => {
    const tools = ToolRuntime.make(
      (options.tools ?? {}) as Tools<Services<Provided>>,
      limits.maxToolCalls,
      searchIndex,
      {
        onToolCallStart: (call) => options.onToolCallStart?.(call) ?? Effect.void,
        onToolCallEnd: (call) => options.onToolCallEnd?.(call) ?? Effect.void,
      },
    )
    const logs: Array<string> = []
    const logged = () => (logs.length > 0 ? { logs: [...logs] } : {})
    // Set only after copy-out and encoding so timeouts cannot report invalid values as completed.
    let returned:
      | {
          value: DataValue
          declarations: Record<string, DataValue>
          promises: PromiseRuntime<Services<Provided>>
        }
      | undefined

    const base: Effect.Effect<Result, unknown, Services<Provided>> = Effect.acquireUseRelease(
      Scope.make("parallel"),
      (scope) =>
        Effect.gen(function* () {
          const parsed = decoded?.program ?? compile(options.code)
          const promises = new PromiseRuntime<Services<Provided>>(scope)
          const input = options.input === undefined ? undefined : copyIn(options.input, "Execution input")
          const interpreter = new Interpreter<Services<Provided>>(
            tools.execute,
            tools.search,
            tools.keys,
            promises,
            logs,
            options.onTrace,
            parsed.source,
            true,
            options.bindings,
            input,
            parsed.declarations,
            new Map(),
            undefined,
            [],
            options.impure,
            tools.notebookReference,
          )
          const executed = yield* interpreter.run(parsed.body)
          const result = copyOut(copyIn(executed.value, "Execution preview"), "nullify") as DataValue
          // Saving happens before the execution reports success, so an invalid durable value fails
          // the execution instead of surprising the host at commit.
          const declarations = encodeDeclarations(executed.declarations, interpreter.notebook(), {
            maxDepth: defaultDurableLimits.maxDepth,
            maxBytes: limits.maxDeclarationBytes,
          }) as Record<string, DataValue>
          returned = { value: result, declarations, promises }
          const warnings = [...(parsed.warnings ?? []), ...(yield* promises.interrupt())]
          return {
            ok: true,
            value: result,
            declarations,
            ...(warnings.length > 0 ? { warnings } : {}),
            ...logged(),
            toolCalls: tools.calls,
          } satisfies Result
        }),
      (scope, exit) => Scope.close(scope, exit),
    )
    const timeoutMs = limits.timeoutMs
    const expired = () =>
      Effect.sync(() => {
        if (returned === undefined) {
          return {
            ok: false,
            error: { kind: "TimeoutExceeded", message: `Execution timed out after ${timeoutMs}ms.` },
            ...logged(),
            toolCalls: tools.calls,
          } satisfies Result
        }
        // The declarations were already encoded successfully, so only the interruption of leftover
        // background work is new information. Keep the timeout warning first so truncation
        // preserves it.
        return {
          ok: true,
          value: returned.value,
          declarations: returned.declarations,
          warnings: [
            {
              kind: "TimeoutExceeded",
              message: `The program returned, but background work was still running at the ${timeoutMs}ms timeout and was interrupted. Await all started promises.`,
            },
            ...returned.promises.diagnostics(),
          ],
          ...logged(),
          toolCalls: tools.calls,
        } satisfies Result
      })
    const operation: Effect.Effect<Result, unknown, Services<Provided>> = timeoutMs === undefined
      ? base
      : Effect.flatMap(
          raceDeadline(Effect.sleep(Duration.millis(timeoutMs)), base),
          (outcome): Effect.Effect<Result> => (outcome.kind === "expired" ? expired() : Effect.succeed(outcome.value)),
        )

    return operation.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.succeed({
              ok: false,
              error: normalizeError(Cause.squash(cause)),
              ...logged(),
              toolCalls: tools.calls,
            } satisfies Result),
      ),
      Effect.map((result) =>
        limits.maxOutputBytes === undefined
          ? result
          : boundOutput(result, limits.maxOutputBytes, limits.maxLogBytes ?? limits.maxOutputBytes),
      ),
    )
  })
}

/**
 * Runs a program for its returned value with tool references and tool.define handles kept, for a host
 * that reads configuration from a program rather than data. The handles stay callable, and the work
 * they start stays owned, until the ambient scope closes. `timeoutMs` bounds the program's own run, not
 * the later calls to its handles.
 */
export const evaluateWithLimits = <const Provided extends Record<string, unknown>>(
  options: ExecuteOptions<Provided>,
  limits: ResolvedExecutionLimits,
  searchIndex: ToolRuntime.DiscoveryPlan["searchIndex"],
): Effect.Effect<Evaluation, never, Services<Provided> | Scope.Scope> =>
  Effect.gen(function* () {
    const decoded = options.program === undefined ? undefined : decodeProgram(options.program)
    if (decoded?.ok === false)
      return { ok: false, error: { kind: "ExecutionFailure", message: decoded.message }, toolCalls: [] } as const
    const tools = ToolRuntime.make(
      (options.tools ?? {}) as Tools<Services<Provided>>,
      limits.maxToolCalls,
      searchIndex,
      {
        onToolCallStart: (call) => options.onToolCallStart?.(call) ?? Effect.void,
        onToolCallEnd: (call) => options.onToolCallEnd?.(call) ?? Effect.void,
      },
    )
    const logs: Array<string> = []
    const handles: Array<ToolHandle> = []
    const scope = yield* Scope.fork(yield* Scope.Scope, "parallel")
    yield* Effect.addFinalizer(() => Effect.sync(() => handles.forEach((handle) => handle.close())))
    const run = Effect.gen(function* () {
      const parsed = decoded?.program ?? compile(options.code, { notebook: false })
      const executed = yield* new Interpreter<Services<Provided>>(
        tools.execute,
        tools.search,
        tools.keys,
        new PromiseRuntime<Services<Provided>>(scope),
        logs,
        options.onTrace,
        parsed.source,
        true,
        options.bindings,
        options.input === undefined ? undefined : copyIn(options.input, "Execution input"),
        parsed.declarations,
        new Map(),
        undefined,
        handles,
        options.impure,
      ).run(parsed.body, false)
      return {
        ok: true,
        value: copyIn(executed.value, "Returned value", true),
        ...(logs.length > 0 ? { logs: [...logs] } : {}),
        toolCalls: tools.calls,
      } as const
    })
    const timeoutMs = limits.timeoutMs
    return yield* (
      timeoutMs === undefined
        ? run
        : Effect.map(raceDeadline(Effect.sleep(Duration.millis(timeoutMs)), run), (outcome) =>
            outcome.kind === "completed"
              ? outcome.value
              : ({
                  ok: false,
                  error: { kind: "TimeoutExceeded", message: `Evaluation timed out after ${timeoutMs}ms.` },
                  ...(logs.length > 0 ? { logs: [...logs] } : {}),
                  toolCalls: tools.calls,
                } as const),
          )
    ).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.succeed({
              ok: false,
              error: normalizeError(Cause.squash(cause)),
              ...(logs.length > 0 ? { logs: [...logs] } : {}),
              toolCalls: tools.calls,
            } as const),
      ),
    )
  })

// raceFirst interrupts the loser and waits for its interruption, so an expired
// deadline still waits for tool cleanup before the result is reported.
function raceDeadline<A, E, R>(
  timer: Effect.Effect<void>,
  base: Effect.Effect<A, E, R>,
): Effect.Effect<{ kind: "completed"; value: A } | { kind: "expired" }, E, R> {
  return Effect.raceFirst(
    base.pipe(Effect.map((value) => ({ kind: "completed" as const, value }))),
    timer.pipe(Effect.as({ kind: "expired" as const })),
  )
}

const utf8ByteLength = (value: string): number => new TextEncoder().encode(value).byteLength

// Drop a replacement character produced by truncating inside a UTF-8 sequence.
const utf8Truncate = (value: string, maxBytes: number): string => {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= maxBytes) return value
  const text = new TextDecoder("utf-8").decode(bytes.slice(0, Math.max(0, maxBytes)))
  return text.endsWith("\uFFFD") ? text.slice(0, -1) : text
}

// Warnings have a separate budget so result data cannot starve diagnostics.
const boundOutput = (result: Result, maxOutputBytes: number, maxLogBytes: number): Result => {
  let truncated = false

  let value: DataValue = null
  let valueBytes = 0
  if (result.ok) {
    const serialized = JSON.stringify(result.value) ?? "null"
    const bytes = utf8ByteLength(serialized)
    if (bytes > maxOutputBytes) {
      truncated = true
      value = `${utf8Truncate(serialized, maxOutputBytes)} [result truncated: ${bytes} bytes exceeds the ${maxOutputBytes}-byte output limit; return a smaller value]`
      valueBytes = maxOutputBytes
    } else {
      value = result.value
      valueBytes = bytes
    }
  }

  const warnings = result.ok ? (result.warnings ?? []) : []
  const keptWarnings: Array<Diagnostic> = []
  let warningBytes = 0
  for (const warning of warnings) {
    const bytes = utf8ByteLength(JSON.stringify(warning)) + 1
    if (warningBytes + bytes > maxOutputBytes) break
    warningBytes += bytes
    keptWarnings.push(warning)
  }
  if (keptWarnings.length < warnings.length) {
    truncated = true
    keptWarnings.push({
      kind: "Truncated",
      message: `${warnings.length - keptWarnings.length} additional warnings omitted by the output limit.`,
    })
  }

  const logs = result.logs ?? []
  const kept: Array<string> = []
  const logBudget = Math.min(maxLogBytes, Math.max(0, maxOutputBytes - valueBytes))
  let logBytes = 0
  for (const line of logs) {
    const lineBytes = utf8ByteLength(line) + 1
    if (logBytes + lineBytes > logBudget) break
    logBytes += lineBytes
    kept.push(line)
  }
  if (kept.length < logs.length) {
    truncated = true
    kept.push(`[logs truncated: showing ${kept.length} of ${logs.length} lines]`)
  }

  if (!truncated) return result
  const warningsPart = keptWarnings.length > 0 ? { warnings: keptWarnings } : {}
  const logsPart = kept.length > 0 ? { logs: kept } : {}
  return result.ok
    ? {
        ok: true,
        value,
        declarations: result.declarations,
        ...warningsPart,
        ...logsPart,
        truncated: true,
        toolCalls: result.toolCalls,
      }
    : { ok: false, error: result.error, ...logsPart, truncated: true, toolCalls: result.toolCalls }
}
