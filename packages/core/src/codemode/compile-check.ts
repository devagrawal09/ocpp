export * as CodeModeCompileCheck from "./compile-check.js"

import { excerptAt, staticToolCalls, toolExpression, type CompileError, type Program } from "@ocpp/codemode"
import { Tool } from "@ocpp/schema/tool"

/**
 * Refusals decided before an execution exists. The model reads them as the `execute` error text; the
 * same fields travel as metadata so a client can render them without parsing that text.
 */
type Diagnostic = {
  readonly kind: string
  readonly message: string
  readonly location?: { readonly line: number; readonly column: number }
  readonly excerpt?: string
  readonly suggestions?: ReadonlyArray<string>
  readonly tool?: string
}

const MAX_REPORTED = 5
const MAX_LISTED = 5

/**
 * The refusal for a program the compiler rejected. Syntax errors are positioned by AST node, and
 * transpilation keeps line numbers, so the excerpt is read from the model's own source.
 */
export function compileFailure(error: CompileError, code: string) {
  const location =
    error.location ??
    (error.node?.loc ? { line: error.node.loc.start.line, column: error.node.loc.start.column + 1 } : undefined)
  const excerpt = error.excerpt ?? (location && excerptAt(code, location))
  return refusal([
    {
      kind: error.kind,
      message: error.message,
      ...(location ? { location } : {}),
      ...(excerpt ? { excerpt } : {}),
      ...(error.suggestions?.length ? { suggestions: error.suggestions } : {}),
    },
  ])
}

/**
 * The refusal for a program that calls tools this agent may not use at all: paths outside its
 * catalog, and paths whose tool its permission rules disable outright. Calls name their tools with
 * static paths, so this is decided before anything runs. Whether one particular call is allowed can
 * depend on its arguments, such as a shell command or a computed file path, so that stays with each
 * tool at run time.
 */
export function unavailableTools(
  program: Program,
  code: string,
  catalog: { readonly available: ReadonlyArray<string>; readonly denied: ReadonlyArray<string> },
) {
  // tools.search is built into the runtime rather than registered by the host.
  const available = ["search", ...catalog.available]
  const calls = staticToolCalls(program.body).filter(
    (call, index, all) => !available.includes(call.path) && all.findIndex((other) => other.path === call.path) === index,
  )
  if (calls.length === 0) return undefined
  return refusal(
    calls.map((call) => {
      const location = {
        line: call.node.loc?.start.line ?? 1,
        column: (call.node.loc?.start.column ?? 0) + 1,
      }
      const excerpt = excerptAt(code, location)
      const base = { location, ...(excerpt ? { excerpt } : {}), tool: call.path }
      if (catalog.denied.includes(call.path))
        return {
          ...base,
          kind: "ToolDenied",
          message:
            "Tool " +
            toolExpression(call.path) +
            " is denied for this agent: its permission rules deny it outright, so no call to it can succeed.",
          suggestions: [
            "Do not retry it. Use an allowed tool instead (tools.search({ query: " +
              JSON.stringify(searchQuery(call.path)) +
              " }) lists them), or ask the user to change this agent's permissions.",
          ],
        }
      return {
        ...base,
        kind: "UnknownTool",
        message: "Unknown tool " + toolExpression(call.path) + "; this agent has no tool at that path.",
        suggestions: unknownToolSuggestions(call.path, available),
      }
    }),
  )
}

function refusal(diagnostics: ReadonlyArray<Diagnostic>) {
  const shown = diagnostics.slice(0, MAX_REPORTED)
  const first = shown[0]
  const suggestions = shown.flatMap((diagnostic) => diagnostic.suggestions ?? [])
  const tools = shown.flatMap((diagnostic) => (diagnostic.tool ? [diagnostic.tool] : []))
  return new Tool.Error({
    message: [
      ...shown.map((diagnostic) =>
        [
          diagnostic.message +
            (diagnostic.location
              ? " (line " + diagnostic.location.line + ", col " + diagnostic.location.column + ")"
              : ""),
          ...(diagnostic.excerpt ? ["Source: " + diagnostic.excerpt] : []),
          ...(diagnostic.suggestions ?? []),
        ].join("\n"),
      ),
      ...(diagnostics.length > shown.length ? [diagnostics.length - shown.length + " more are not shown."] : []),
    ].join("\n\n"),
    metadata: {
      executionStatus: "refused",
      ...(first
        ? {
            kind: first.kind,
            ...(first.location ? { location: first.location } : {}),
            ...(first.excerpt ? { excerpt: first.excerpt } : {}),
          }
        : {}),
      ...(suggestions.length > 0 ? { suggestions } : {}),
      ...(tools.length > 0 ? { tools } : {}),
    },
  })
}

/** Close catalog paths, the namespace's own tools, and a search that finds the right one. */
function unknownToolSuggestions(path: string, available: ReadonlyArray<string>) {
  const children = available.filter((candidate) => candidate.startsWith(path + "."))
  const matches = closest(path, available)
  const namespace = path.split(".").slice(0, -1).join(".")
  const siblings = namespace === "" ? [] : available.filter((candidate) => candidate.startsWith(namespace + "."))
  return [
    ...(children.length > 0
      ? [toolExpression(path) + " is a namespace; call one of its tools: " + list(children)]
      : []),
    ...(matches.length > 0 ? ["Did you mean " + matches.map(toolExpression).join(" or ") + "?"] : []),
    ...(children.length === 0 && matches.length === 0 && siblings.length > 0
      ? ["Tools in " + toolExpression(namespace) + ": " + list(siblings)]
      : []),
    matches.length === 1
      ? "Check its exact signature with tools.search({ query: " + JSON.stringify(toolExpression(matches[0]!)) + " })"
      : "Find the right tool with tools.search({ query: " +
        JSON.stringify(searchQuery(path)) +
        " }) and call the exact path it returns",
  ]
}

/**
 * Catalog paths within a small edit distance of the requested one, compared as whole paths and by
 * their last segment, so both a misspelled name and a right name under the wrong namespace match.
 */
function closest(path: string, available: ReadonlyArray<string>) {
  const segments = path.split(".")
  const name = normalizeSegment(segments.at(-1) ?? "")
  const namespace = segments.slice(0, -1).join(".")
  const limit = Math.max(1, Math.min(3, Math.floor(name.length / 3)))
  return available
    .map((candidate) => {
      const parts = candidate.split(".")
      const sameNamespace = parts.slice(0, -1).join(".") === namespace
      return {
        candidate,
        score: Math.min(
          distance(path.toLowerCase(), candidate.toLowerCase()),
          distance(name, normalizeSegment(parts.at(-1) ?? "")) + (sameNamespace ? 0 : 1),
        ),
      }
    })
    .filter((item) => item.score <= limit)
    .toSorted((left, right) => left.score - right.score || left.candidate.localeCompare(right.candidate))
    .slice(0, 3)
    .map((item) => item.candidate)
}

// Case and word separators rarely distinguish tools, so createIssue matches create_issue.
function normalizeSegment(segment: string) {
  return segment.toLowerCase().replaceAll("_", "").replaceAll("-", "")
}

/** Optimal string alignment distance: edits plus adjacent transpositions, the usual typing slips. */
function distance(left: string, right: string) {
  const rows = Array.from({ length: left.length + 1 }, (_, row) =>
    Array.from({ length: right.length + 1 }, (_, column) => (row === 0 ? column : column === 0 ? row : 0)),
  )
  for (let row = 1; row <= left.length; row++)
    for (let column = 1; column <= right.length; column++) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1
      const best = Math.min(rows[row - 1]![column]! + 1, rows[row]![column - 1]! + 1, rows[row - 1]![column - 1]! + cost)
      rows[row]![column] =
        row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]
          ? Math.min(best, rows[row - 2]![column - 2]! + 1)
          : best
    }
  return rows[left.length]![right.length]!
}

function searchQuery(path: string) {
  return path
    .split(".")
    .flatMap((segment) => segment.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[_-]/))
    .join(" ")
    .toLowerCase()
}

function list(paths: ReadonlyArray<string>) {
  const shown = paths.slice(0, MAX_LISTED).map(toolExpression).join(", ")
  return paths.length > MAX_LISTED ? shown + ", and " + (paths.length - MAX_LISTED) + " more" : shown
}
