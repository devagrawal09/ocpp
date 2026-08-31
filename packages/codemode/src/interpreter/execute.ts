import { parse } from "acorn"
import { Cause, Deferred, Duration, Effect, Scope } from "effect"
// #transpile: conditional import — full typescript on node/bun, an identity
// pass-through on workerd (the compiler is ~11 MiB and can't init there).
import { transpile } from "#transpile"
import type { DataValue, Diagnostic, ExecuteOptions, ResolvedExecutionLimits, Result } from "../codemode.js"
import { copyIn, copyOut, ToolRuntime, type Services } from "../tool-runtime.js"
import type { Tools } from "../tools.js"
import { normalizeError } from "./errors.js"
import { InterpreterRuntimeError, isRecord, type ProgramNode } from "./model.js"
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

  // Allocate execution state inside suspension so reused Effects never share it.
  return Effect.suspend(() => {
    // The deadline pauses while tool calls are pending: host tools own their wait
    // policies (user questions, permission prompts, shell timeouts), so awaiting
    // them must not consume the program budget or interrupt an interactive call.
    const deadline = limits.timeoutMs === undefined ? undefined : makeToolCallDeadline(limits.timeoutMs)
    const tools = ToolRuntime.make(
      (options.tools ?? {}) as Tools<Services<Provided>>,
      limits.maxToolCalls,
      searchIndex,
      {
        onToolCallStart: (call) =>
          deadline === undefined
            ? (options.onToolCallStart?.(call) ?? Effect.void)
            : Effect.andThen(deadline.pause, () => options.onToolCallStart?.(call) ?? Effect.void),
        onToolCallEnd: (call) =>
          deadline === undefined
            ? (options.onToolCallEnd?.(call) ?? Effect.void)
            : Effect.andThen(deadline.resume, () => options.onToolCallEnd?.(call) ?? Effect.void),
      },
    )
    const logs: Array<string> = []
    const logged = () => (logs.length > 0 ? { logs: [...logs] } : {})
    // Set only after copy-out so timeouts cannot report invalid values as completed.
    let returned: { value: DataValue; promises: PromiseRuntime<Services<Provided>> } | undefined

    const base: Effect.Effect<Result, unknown, Services<Provided>> = Effect.acquireUseRelease(
      Scope.make("parallel"),
      (scope) =>
        Effect.gen(function* () {
          const parsed = parseProgram(options.code)
          const promises = new PromiseRuntime<Services<Provided>>(scope)
          const interpreter = new Interpreter<Services<Provided>>(
            tools.execute,
            tools.search,
            tools.keys,
            promises,
            logs,
            options.onTrace,
            parsed.source,
          )
          const value = yield* interpreter.run(parsed.program)
          const result = copyOut(copyIn(value, "Execution result"), "nullify") as DataValue
          returned = { value: result, promises }
          const warnings = yield* promises.interrupt()
          return {
            ok: true,
            value: result,
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
        // Keep the timeout warning first so truncation preserves it.
        return {
          ok: true,
          value: returned.value,
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
    const operation =
      deadline === undefined
        ? base
        : Effect.flatMap(raceDeadline(deadline.timer, base), (outcome) =>
            outcome.kind === "expired" ? expired() : Effect.succeed(outcome.value),
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
        limits.maxOutputBytes === undefined ? result : boundOutput(result, limits.maxOutputBytes),
      ),
    )
  })
}

type ToolCallDeadline = {
  readonly pause: Effect.Effect<void>
  readonly resume: Effect.Effect<void>
  readonly timer: Effect.Effect<void>
}

// A wall-clock deadline that pauses while tool calls are pending: awaiting a host
// tool never consumes budget and is never interrupted by the timeout, so
// interactive tools can block on user input indefinitely. Pauses shift the
// deadline rather than re-arming a fresh budget per tool call, and the timer only
// fires while the clock is running (no pending call).
function makeToolCallDeadline(timeoutMs: number): ToolCallDeadline {
  const state = {
    pending: 0,
    remainingMs: timeoutMs,
    mark: Date.now(),
    gate: undefined as Deferred.Deferred<void> | undefined,
  }
  const pause = Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    yield* Effect.sync(() => {
      state.pending += 1
      if (state.pending > 1) return
      const now = Date.now()
      state.remainingMs -= now - state.mark
      state.mark = now
      state.gate = gate
    })
  })
  const resume = Effect.gen(function* () {
    const gate = yield* Effect.sync(() => {
      state.pending -= 1
      if (state.pending > 0) return undefined
      state.mark = Date.now()
      const current = state.gate
      state.gate = undefined
      return current
    })
    if (gate !== undefined) yield* Deferred.succeed(gate, undefined)
  })
  const timer = Effect.gen(function* () {
    while (true) {
      const snapshot = yield* Effect.sync(() => ({
        // `gate` is set exactly while a tool call is pending (pause and resume
        // update both fields in one atomic step).
        gate: state.gate,
        left: state.pending > 0 ? state.remainingMs : state.remainingMs - (Date.now() - state.mark),
      }))
      if (snapshot.gate !== undefined) {
        yield* Deferred.await(snapshot.gate)
        continue
      }
      if (snapshot.left <= 0) return
      yield* Effect.sleep(Duration.millis(snapshot.left))
    }
  })
  return { pause, resume, timer }
}

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

const parseProgram = (code: string): { readonly program: ProgramNode; readonly source: string } => {
  const transpiled = transpile(`async function __codemode__() {\n${code}\n}`)

  if (transpiled.error !== undefined) {
    throw new InterpreterRuntimeError(`Failed to parse TypeScript: ${transpiled.error}`, undefined, "ParseError")
  }

  const bodyStart = transpiled.outputText.indexOf("{") + 1
  const bodyEnd = transpiled.outputText.lastIndexOf("}")
  const executableCode = transpiled.outputText.slice(bodyStart, bodyEnd)
  const parsed = parse(executableCode, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
    locations: true,
  }) as unknown

  if (!isRecord(parsed) || parsed.type !== "Program" || !Array.isArray(parsed.body)) {
    throw new InterpreterRuntimeError("Failed to parse script as a Program node.")
  }

  return { program: parsed as ProgramNode, source: executableCode }
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
const boundOutput = (result: Result, maxOutputBytes: number): Result => {
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
  const logBudget = Math.max(0, maxOutputBytes - valueBytes)
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
        ...warningsPart,
        ...logsPart,
        truncated: true,
        toolCalls: result.toolCalls,
      }
    : { ok: false, error: result.error, ...logsPart, truncated: true, toolCalls: result.toolCalls }
}
