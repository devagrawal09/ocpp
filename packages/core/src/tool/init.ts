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
import { Effect, Result, type Scope } from "effect"
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

/** Runs a tool a handle calls, in the execution that called the handle. */
export type Call = (name: string, tool: Tool.Info, input: unknown, index: number) => Effect.Effect<unknown, unknown>

// Compiling is the costly step and depends only on the source, so each distinct init.ts compiles once.
const programs = new Map<string, Result.Result<Program, unknown>>()

/**
 * Evaluates init.ts for one agent against every registered tool, so its handles may call any of them. Without
 * `call` its handles only describe themselves; with it they run tools in the execution the scope belongs to, and
 * stay callable until that scope closes. init.ts itself may not call tools: it is evaluated again for every
 * execution, and its lists must not depend on what a tool returns.
 */
export const evaluate = (
  init: NonNullable<ToolLists.Selection["init"]>,
  registry: ReadonlyMap<string, Tool.Info>,
  call?: Call,
): Effect.Effect<Evaluated, never, Scope.Scope> =>
  Effect.gen(function* () {
    const hash = Hash.fast(init.source)
    const compiled = programs.get(hash) ?? Result.try({ try: () => CodeMode.compile(init.source), catch: (error) => error })
    programs.set(hash, compiled)
    if (Result.isFailure(compiled))
      return {
        error: `init.ts does not compile: ${compiled.failure instanceof CompileError ? CodeModeCompileCheck.compileFailure(compiled.failure, init.source).message : String(compiled.failure)}`,
      }
    const program = compiled.success
    const state = { settled: false }
    const result = yield* CodeMode.evaluate({
      code: program.source,
      program,
      limits: { maxToolCalls: limits.maxToolCalls },
      tools: CodeModeTool.tools(registry, (name, tool, input, index) => {
        if (!state.settled)
          return Effect.fail(
            toolError(
              `init.ts cannot call ${toolExpression(CodeModeTool.qualifiedName(tool))} while it builds its tool lists; call tools inside tool.define handles.`,
            ),
          )
        if (call === undefined) return Effect.fail(toolError("init.ts handles run only inside an execution."))
        return call(name, tool, input, index)
      }),
    })
    state.settled = true
    if (!result.ok) return { error: `init.ts failed: ${result.error.message}` }
    return yield* select(result.value, init.agent, registry)
  })

const select = Effect.fnUntraced(function* (value: unknown, agent: string, registry: ReadonlyMap<string, Tool.Info>) {
  if (!isLists(value))
    return { error: "init.ts must return tool lists by agent, such as return { build: [tools.read, tools.grep] }." }
  const entries = value[agent]
  if (entries === undefined) return { error: `init.ts returns no tool list for the ${agent} agent, so it has no tools.` }
  if (!Array.isArray(entries))
    return { error: `init.ts must return an array of tools for the ${agent} agent, such as [tools.read, tools.grep].` }
  const invalid = entries.findIndex((entry) => !isToolReference(entry) && !isToolHandle(entry))
  if (invalid !== -1)
    return {
      error: `init.ts ${agent}[${invalid}] is neither a tool such as tools.read, a namespace such as tools.linear, nor a tool.define handle.`,
    }
  const paths = entries.filter(isToolReference).map((reference) => reference.path.join("."))
  const handles = yield* SubagentCustomTool.validate(entries.filter(isToolHandle)).pipe(Effect.result)
  if (handles._tag === "Failure") return { error: `init.ts ${agent} list: ${handles.failure.message}` }
  const clash = handles.success.find(
    (handle) => handle.definition.name === "search" || paths.includes(handle.definition.name),
  )
  if (clash !== undefined)
    return {
      error: `init.ts ${agent} list has two tools at ${toolExpression(clash.definition.name)}: rename the tool.define handle.`,
    }
  const available = Array.from(registry.values(), CodeModeTool.qualifiedName)
  const missing = paths.filter((path) => !available.some((candidate) => ToolLists.includes([path], candidate)))
  return {
    paths,
    handles: SubagentCustomTool.make(handles.success),
    ...(missing.length === 0
      ? {}
      : {
          notice: `init.ts lists ${missing.map(toolExpression).join(", ")} for the ${agent} agent, but no tool here provides ${missing.length === 1 ? "it" : "them"}. The rest of its list applies.`,
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
