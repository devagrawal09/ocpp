export * as ToolInit from "./init.js"

import {
  CodeMode,
  CompileError,
  isToolHandle,
  isToolReference,
  toolError,
  toolExpression,
  type Program,
} from "@ocpp/codemode"
import type { Tool } from "@ocpp/schema/tool"
import { Hash } from "@ocpp/util/hash"
import { Context, Effect, Result, type Scope } from "effect"
import { CodeModeCompileCheck } from "../codemode/compile-check.js"
import { limits } from "../codemode/limits.js"
import { CodeModeTool } from "../codemode/tool.js"
import { ToolLists } from "./lists.js"
import { SubagentCustomTool } from "./plugin/subagent-custom.js"

/** One agent's list from init.ts: the registry paths it names and its tool.define handles as tools. */
export type Evaluated =
  | {
      readonly paths: ReadonlyArray<string>
      readonly handles: ReadonlyArray<Tool.Info>
      /** A problem that leaves the rest of the list in place, such as a path no tool here provides. */
      readonly notice?: string
    }
  | { readonly error: string }

/** Runs a tool a handle calls, as the call `id` of the execution that called the handle. */
export type Call = (name: string, tool: Tool.Info, input: unknown, id: string) => Effect.Effect<unknown, unknown>

/**
 * How long init.ts may take to return its lists. A real one only builds arrays and handles, which takes
 * milliseconds; every step of every top-level Session in the project waits on it, so a program that never
 * returns must fail quickly and visibly, with room left for a loaded machine.
 */
export const TIMEOUT_MS = 3_000

/**
 * The call that is running an init.ts handle. The calls a handle makes are numbered under it, as `<call>:<n>`,
 * so they read as part of the execution that called the handle, and number the same way when it runs again.
 */
const Invocation = Context.Reference<{ readonly id: string; readonly next: () => number } | undefined>(
  "@ocpp/ToolInit/Invocation",
  { defaultValue: () => undefined },
)

// Compiling is the costly step and depends only on the source, so each init.ts file keeps the program compiled from
// its latest content.
const programs = new Map<string, { readonly hash: string; readonly program: Program }>()

/**
 * Evaluates init.ts for one agent against every registered tool, so its handles may call any of them. Without
 * `call` its handles only describe themselves; with it they run tools in the execution the scope belongs to, and
 * stay callable until that scope closes. init.ts itself may not call tools, read the clock or read randomness: it is
 * evaluated again for every execution, and a resumed execution must get the same lists.
 */
export const evaluate = (
  init: NonNullable<ToolLists.Selection["init"]>,
  registry: ReadonlyMap<string, Tool.Info>,
  call?: Call,
): Effect.Effect<Evaluated, never, Scope.Scope> =>
  Effect.gen(function* () {
    const file = init.file ?? ToolLists.FILE
    const hash = Hash.fast(init.source)
    const cached = programs.get(init.file ?? "")
    const compiled =
      cached?.hash === hash
        ? Result.succeed(cached.program)
        : Result.try({ try: () => CodeMode.compile(init.source, { notebook: false }), catch: (error) => error })
    if (Result.isFailure(compiled))
      return {
        error: `${file} does not compile: ${compiled.failure instanceof CompileError ? CodeModeCompileCheck.compileFailure(compiled.failure, init.source).message : String(compiled.failure)}`,
      }
    if (cached?.hash !== hash) programs.set(init.file ?? "", { hash, program: compiled.success })
    const program = compiled.success
    const state = { settled: false }
    const result = yield* CodeMode.evaluate({
      code: program.source,
      program,
      limits: { maxToolCalls: limits.maxToolCalls, timeoutMs: TIMEOUT_MS },
      impure: (helper) => {
        if (!state.settled)
          throw new Error(
            `init.ts cannot read ${helper === "time.now" ? "time.now()" : "Math.random()"} while it builds its tool lists: they must come out the same every time it is evaluated. Read it inside a tool.define handle instead.`,
          )
        return helper === "time.now" ? Date.now() : Math.random()
      },
      tools: CodeModeTool.tools(registry, (name, tool, input) =>
        Effect.gen(function* () {
          if (!state.settled)
            return yield* Effect.fail(
              toolError(
                `init.ts cannot call ${toolExpression(CodeModeTool.qualifiedName(tool))} while it builds its tool lists; call tools inside tool.define handles.`,
              ),
            )
          const invocation = yield* Invocation
          if (call === undefined || invocation === undefined)
            return yield* Effect.fail(toolError("init.ts handles run only inside an execution."))
          return yield* call(name, tool, input, invocation.id + ":" + invocation.next())
        }),
      ),
    })
    state.settled = true
    if (!result.ok)
      return {
        error:
          result.error.kind === "TimeoutExceeded"
            ? `${file} did not return its tool lists within ${TIMEOUT_MS / 1000} seconds; look for a loop that never ends.`
            : `${file} failed: ${result.error.message}`,
      }
    return yield* select(result.value, init.agent, file, registry)
  })

const select = Effect.fnUntraced(function* (
  value: unknown,
  agent: string,
  file: string,
  registry: ReadonlyMap<string, Tool.Info>,
) {
  if (!isLists(value))
    return { error: `${file} must return tool lists by agent, such as return { build: [tools.read, tools.grep] }.` }
  const entries = value[agent]
  if (entries === undefined)
    return { error: `${file} returns no tool list for the ${agent} agent, so it has no tools.` }
  if (!Array.isArray(entries))
    return { error: `${file} must return an array of tools for the ${agent} agent, such as [tools.read, tools.grep].` }
  const invalid = entries.findIndex((entry) => !isToolReference(entry) && !isToolHandle(entry))
  if (invalid !== -1)
    return {
      error: `${file} ${agent}[${invalid}] is neither a tool such as tools.read, a namespace such as tools.linear, nor a tool.define handle.`,
    }
  const paths = entries.filter(isToolReference).map((reference) => reference.path.join("."))
  const handles = yield* SubagentCustomTool.validate(entries.filter(isToolHandle)).pipe(Effect.result)
  if (handles._tag === "Failure") return { error: `${file} ${agent} list: ${handles.failure.message}` }
  const clash = handles.success.find(
    (handle) => handle.definition.name === "search" || paths.includes(handle.definition.name),
  )
  if (clash !== undefined)
    return {
      error: `${file} ${agent} list has two tools at ${toolExpression(clash.definition.name)}: rename the tool.define handle.`,
    }
  const available = Array.from(registry.values(), CodeModeTool.qualifiedName)
  // tools.search is built into every execution, so listing it is harmless and adds nothing.
  const missing = paths.filter(
    (path) => path !== "search" && !available.some((candidate) => ToolLists.includes([path], candidate)),
  )
  return {
    paths,
    handles: SubagentCustomTool.make(handles.success).map((tool) => ({
      ...tool,
      execute: (input: unknown, context: Tool.Context) =>
        Effect.suspend(() => {
          const calls = { count: 0 }
          return tool
            .execute(input, context)
            .pipe(Effect.provideService(Invocation, { id: context.id, next: () => calls.count++ }))
        }),
    })),
    ...(missing.length === 0
      ? {}
      : {
          notice: `${file} lists ${missing.map(toolExpression).join(", ")} for the ${agent} agent, but no tool here provides ${missing.length === 1 ? "it" : "them"}. The rest of its list applies.`,
        }),
  }
})

function isLists(value: unknown): value is Readonly<Record<string, unknown>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    !isToolHandle(value) &&
    !isToolReference(value)
  )
}
