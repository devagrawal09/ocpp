import { parse } from "acorn"
import { transpile } from "#transpile"
import { reservedNames } from "./globals.js"
import {
  IR_VERSION,
  isPromiseAllCall,
  isRecord,
  type AstNode,
  type Program,
  type ProgramNode,
  type SourcePosition,
} from "./ir.js"
import { SourceMap } from "./source-map.js"
import { Suggestions } from "./suggestions.js"

/**
 * A compile-time diagnostic. Compilation is source in, versioned IR out or this error, so the
 * compiler needs no knowledge of the interpreter, the host, or persistence.
 */
export class CompileError extends Error {
  constructor(
    message: string,
    readonly kind: "ParseError" | "UnsupportedSyntax",
    readonly node?: AstNode,
    readonly suggestions?: ReadonlyArray<string>,
    /** One-based source position for diagnostics that have no AST node, such as parse failures. */
    readonly location?: { readonly line: number; readonly column: number },
    /** The source line at `location`, so a host can show what failed without the program. */
    readonly excerpt?: string,
  ) {
    super(message)
    this.name = "CompileError"
  }
}

const MAX_EXCERPT_LENGTH = 200

/**
 * The source line at a one-based position, bounded so a diagnostic stays small. Its indentation is
 * kept so the reported column still counts from the start of the excerpt.
 */
export function excerptAt(source: string, location: { readonly line: number }): string | undefined {
  const line = source.split("\n")[location.line - 1]?.trimEnd()
  if (line === undefined || line.trim() === "") return undefined
  return line.length > MAX_EXCERPT_LENGTH ? line.slice(0, MAX_EXCERPT_LENGTH) + "..." : line
}

/** Maps a position in the transpiled output to the source as written, if the source produced it. */
type Original = (position: SourcePosition) => SourcePosition | undefined

// acorn reports positions in the transpiled output as a one-based line with a zero-based column and
// appends "(line:column)" to its message. The location is kept separately, in the source as written,
// so the suffix is dropped from the message.
function parseError(source: string, error: unknown, original: Original): CompileError {
  const found =
    error instanceof SyntaxError && isRecord(error) && isRecord(error.loc)
      ? original({ line: Number(error.loc.line), column: Number(error.loc.column) })
      : undefined
  const position = found && { line: found.line, column: found.column + 1 }
  const message = error instanceof Error ? error.message.replace(/ \(\d+:\d+\)$/, "") : String(error)
  return new CompileError(
    "Failed to parse: " + message,
    "ParseError",
    undefined,
    undefined,
    position,
    position && excerptAt(source, position),
  )
}

const noModules =
  'Remove it: there are no modules. Host capabilities are tools; find them with tools.search({ query: "what you need" }).'
const autoPublish =
  "Remove export: export const total = 1 becomes const total = 1, which is saved to the notebook automatically."
const records = "Use a function that returns a plain record: function counter(start) { return { value: start } }"

const forbidden = new Map([
  [
    "YieldExpression",
    {
      message: "generators are not supported",
      suggestions: ["Return an array instead of yielding: function pages(ids) { return ids.map((id) => load(id)) }"],
    },
  ],
  ["ImportDeclaration", { message: "imports are not supported", suggestions: [noModules] }],
  ["ImportExpression", { message: "dynamic imports are not supported", suggestions: [noModules] }],
  [
    "ExportNamedDeclaration",
    {
      message: "export is not supported; direct top-level const and function declarations are published automatically",
      suggestions: [autoPublish],
    },
  ],
  [
    "ExportDefaultDeclaration",
    {
      message: "export is not supported; direct top-level const and function declarations are published automatically",
      suggestions: [autoPublish],
    },
  ],
  ["ExportAllDeclaration", { message: "re-exports are not supported", suggestions: [noModules] }],
  ["ClassDeclaration", { message: "classes are not supported", suggestions: [records] }],
  ["ClassExpression", { message: "classes are not supported", suggestions: [records] }],
  [
    "ThisExpression",
    {
      message: "this is not supported",
      suggestions: ["Pass the value as a parameter: function area(shape) { return shape.width * shape.height }"],
    },
  ],
])

const regexUnavailable =
  "Regular expressions are not available; match text with string methods such as includes, startsWith, indexOf, slice, and split"

// Removed language values whose helper replacements return plain durable data.
const removedGlobals = new Map([
  [
    "Date",
    {
      message: "Date is not a value; use time.now(), time.parse(text), time.add(...), and time.format(...)",
      suggestions: [
        'Use epoch milliseconds with the time helpers: time.now(), time.parse("2024-05-01T00:00:00Z"), time.add(at, { days: 1 }), time.format(at), time.parts(at).',
      ],
    },
  ],
  [
    "Map",
    {
      message: "Map is not a value; use immutable records and arrays",
      suggestions: [
        "Use a record: let counts = {}; counts = { ...counts, [key]: (counts[key] ?? 0) + 1 }; list it with Object.entries(counts).",
      ],
    },
  ],
  [
    "Set",
    {
      message: "Set is not a value; use immutable arrays",
      suggestions: [
        "Use an array: items.includes(item) tests membership, and items.filter((item, index) => items.indexOf(item) === index) removes duplicates.",
      ],
    },
  ],
  [
    "URL",
    {
      message: "URL is not a value; use url.parse(text) and url.format(record)",
      suggestions: [
        "url.parse(text) returns a record with scheme, host, path, query, and hash; url.format(record) builds the text.",
      ],
    },
  ],
  [
    "URLSearchParams",
    {
      message: "URLSearchParams is not a value; use url.parseQuery(text) and url.formatQuery(entries)",
      suggestions: [
        "Read the parameters as [{ name, value }] records: url.parse(text).query for a URL, url.parseQuery(text) for a bare query string",
        'Build a query string from those records: url.formatQuery([{ name: "q", value: "term" }])',
      ],
    },
  ],
  // Pattern matching is unavailable until the runtime has an engine whose cost is bounded by input
  // length. A backtracking matcher blocks the host, so no partial pattern support is offered.
  ["RegExp", { message: regexUnavailable, suggestions: Suggestions.regex() }],
  ["regex", { message: regexUnavailable, suggestions: Suggestions.regex() }],
])

const promiseUnsupported = "Promise is not supported; tool calls block and return their result directly."
const promiseSuggestions = [
  "Call the tool and use its value directly: const file = tools.fs.read({ path })",
  "Run independent work concurrently as separate execute calls instead.",
]

const mutatingMethods = new Set([
  "assign",
  "copyWithin",
  "fill",
  "pop",
  "push",
  "reverse",
  "shift",
  "sort",
  "splice",
  "unshift",
])

export function compile(code: string): Program {
  if (code.trim().length === 0) throw new CompileError("Code cannot be empty.", "ParseError")
  const transpiled = transpile(code)
  if (transpiled.error !== undefined)
    throw new CompileError(
      "Failed to parse TypeScript: " + transpiled.error,
      "ParseError",
      undefined,
      undefined,
      transpiled.location,
      transpiled.location && excerptAt(code, transpiled.location),
    )

  const original: Original =
    transpiled.mappings === undefined ? (position) => position : SourceMap.originalPosition(transpiled.mappings)
  const parsed = parseSource(transpiled.outputText, code, original)
  if (!isRecord(parsed) || parsed.type !== "Program" || !Array.isArray(parsed.body))
    throw new CompileError("Failed to compile script as a Program.", "ParseError")

  const program = parsed as ProgramNode
  if (transpiled.mappings !== undefined) restorePositions(program, original)
  // Declared names come first so a bad notebook name reports its own diagnostic instead of the
  // generic one `validate` produces for the same identifier elsewhere in a program.
  const names = declarations(program)
  validate(program)
  rejectEarlyReturns(program)
  const warnings = [
    ...(containsNode(program, (node) => node.type === "AwaitExpression")
      ? [
          {
            kind: "Compatibility" as const,
            message:
              "await was ignored for compatibility. Do not use it: operations within a script are semantically synchronous. Only execution of the script as a whole is asynchronous to the model.",
          },
        ]
      : []),
    ...(containsNode(program, isPromiseAllCall)
      ? [
          {
            kind: "Compatibility" as const,
            message:
              "Promise.all was serialized for compatibility. Do not use it: operations within a script are semantically synchronous, so array entries already run in order.",
          },
        ]
      : []),
  ]
  return {
    version: IR_VERSION,
    source: transpiled.outputText,
    body: program,
    declarations: names,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

// acorn throws a bare SyntaxError, which is the only reason the compiler catches anything: the
// failure is re-thrown as a positioned ParseError so hosts never see an unstructured throw.
function parseSource(transpiled: string, source: string, original: Original): unknown {
  try {
    return parse(transpiled, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowReturnOutsideFunction: true,
      locations: true,
    })
  } catch (error) {
    throw parseError(source, error, original)
  }
}

/**
 * The transpiler re-prints the program: it splits statements onto their own lines, joins wrapped
 * expressions, and drops type declarations. Each node's line and column are mapped back to the source
 * as written, so every diagnostic, compile time or run time, points at the author's own line. Node
 * offsets still index the transpiled `source`, which is the text the runtime slices.
 */
function restorePositions(node: AstNode, original: Original): void {
  const start = node.loc && original(node.loc.start)
  // Output that no source produced, such as the `export {}` left by an elided import, has no position.
  if (node.loc) node.loc = start && { start, end: original(node.loc.end) ?? start }
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc") continue
    for (const item of Array.isArray(value) ? value : [value])
      if (isRecord(item) && typeof item.type === "string") restorePositions(item as AstNode, original)
  }
}

function containsNode(node: AstNode, predicate: (node: AstNode) => boolean): boolean {
  if (predicate(node)) return true
  return Object.entries(node).some(([key, value]) => {
    if (key === "loc") return false
    if (Array.isArray(value))
      return value.some(
        (item) => isRecord(item) && typeof item.type === "string" && containsNode(item as AstNode, predicate),
      )
    return isRecord(value) && typeof value.type === "string" && containsNode(value as AstNode, predicate)
  })
}

/**
 * A `return` outside a function ends the program, so a durable declaration after it would never be
 * initialized while its name was already reserved. The rule is deliberately syntactic: a `return` is
 * rejected whenever a later top-level statement declares a durable name, with no reasoning about
 * which branch actually runs. A final preview `return` after every declaration stays valid.
 */
function rejectEarlyReturns(program: ProgramNode): void {
  const lastDeclaration = program.body.reduce((last, value, index) => {
    const node = requireNode(value)
    return node.type === "FunctionDeclaration" || (node.type === "VariableDeclaration" && node.kind === "const")
      ? index
      : last
  }, -1)
  for (const [index, value] of program.body.entries()) {
    if (index >= lastDeclaration) return
    const found = findReturn(requireNode(value))
    if (found)
      throw unsupported(
        "This return would skip a durable declaration that follows it, leaving its notebook name reserved but never saved. Move the return after every top-level const and function declaration.",
        found,
        [
          "Keep one preview return at the end, and compute conditional values instead of exiting early: const later = done ? null : compute(first).",
        ],
      )
  }
}

// Nested functions have their own returns, so the search stops at every function boundary.
function findReturn(node: AstNode): AstNode | undefined {
  if (node.type === "ReturnStatement") return node
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  )
    return undefined
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc") continue
    const children = Array.isArray(value) ? value : [value]
    for (const item of children) {
      if (!isRecord(item) || typeof item.type !== "string") continue
      const found = findReturn(item as AstNode)
      if (found) return found
    }
  }
  return undefined
}

// Direct top-level const and function declarations are the durable notebook surface. Everything
// nested inside a block, loop, or function stays activation-local.
function declarations(program: ProgramNode): ReadonlyArray<string> {
  return program.body.flatMap((statement) => {
    const node = requireNode(statement)
    if (node.type === "FunctionDeclaration") {
      const id = requireNode(node.id)
      if (id.type !== "Identifier" || typeof id.name !== "string")
        throw unsupported("Top-level function declarations must be named.", node)
      return [durableName(id.name, id)]
    }
    if (node.type !== "VariableDeclaration" || node.kind !== "const") return []
    return requireArray(node.declarations, node).map((value) => {
      const item = requireNode(value)
      const id = requireNode(item.id)
      if (id.type !== "Identifier" || typeof id.name !== "string")
        throw unsupported(
          "Top-level const declarations save one durable name each; destructure inside a block or function instead.",
          id,
          Suggestions.destructuring(id, item.init),
        )
      const init = item.init
      if (init === undefined || init === null)
        throw unsupported("Top-level const '" + id.name + "' requires an initializer.", item, [
          "Give it a value, const " + id.name + " = ..., or use let " + id.name + " for working state.",
        ])
      // Handles exist only for one execution, so catch the natural const form before anything runs.
      if (requireNode(init).type === "CallExpression" && isToolDefine(requireNode(requireNode(init).callee)))
        throw unsupported(
          "Tool handles are activation-local and cannot be saved; bind '" +
            id.name +
            "' with let, or create the handle inside a function.",
          item,
          [
            "Bind it with let so it lives for this execution only: let " +
              id.name +
              " = tool.define({ name, description, inputSchema, outputSchema, execute })",
            "Or create the handle inside the function that passes it to a tool.",
          ],
        )
      return durableName(id.name, id)
    })
  })
}

// A notebook name is permanent, so shadowing a builtin at the top level would hide it from every
// later execution in the Session. Nested names are ordinary lexical bindings and stay unrestricted.
function durableName(name: string, node: AstNode): string {
  if (reservedNames.has(name))
    throw unsupported(
      "'" +
        name +
        "' is a runtime global and cannot become a permanent notebook name; it would hide the builtin from every later execution. Choose a different name, or declare it inside a block or function.",
      node,
      ["Rename it, e.g. const " + name + "Result = ..."],
    )
  return name
}

function validate(node: AstNode): void {
  // TypeScript drops unused and type-only imports and leaves a bare `export {}` in their place.
  if (
    node.type === "ExportNamedDeclaration" &&
    node.declaration == null &&
    node.source == null &&
    requireArray(node.specifiers, node).length === 0
  )
    throw unsupported("imports and exports are not supported", node, [noModules])
  const rejected = forbidden.get(node.type)
  if (rejected) throw unsupported(rejected.message, node, rejected.suggestions)
  if (
    (node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression") &&
    (node.async === true || node.generator === true)
  )
    throw unsupported("Async functions and generators are not supported.", node, [
      node.async === true
        ? "Remove async and await: tool calls block and return their value, e.g. function load(path) { return tools.fs.read({ path }) }"
        : "Return an array instead of yielding: function pages(ids) { return ids.map((id) => load(id)) }",
    ])
  if (node.type === "ForOfStatement" && node.await === true)
    throw unsupported("for await...of is not supported.", node, [
      "Use for...of: tool calls inside the loop already block and return their value.",
    ])
  if (node.type === "VariableDeclaration" && node.kind === "var")
    throw unsupported("var is not supported; use activation-local let or immutable const.", node, [
      "Use let for working state or const to save a notebook value: let " +
        (identifierName(requireNode(requireArray(node.declarations, node)[0]).id) ?? "total") +
        " = ...",
    ])
  if (node.type === "Literal" && isRecord(node.regex))
    throw unsupported(regexUnavailable + ".", node, Suggestions.regex())
  if (node.type === "AssignmentExpression") {
    const left = requireNode(node.left)
    if (hasMemberTarget(left))
      throw unsupported(
        "Arrays and objects are immutable; assign a new value instead.",
        left,
        Suggestions.memberAssignment(left, Suggestions.assignedValue(node)),
      )
  }
  if (
    (node.type === "ForOfStatement" || node.type === "ForInStatement") &&
    requireNode(node.left).type !== "VariableDeclaration" &&
    hasMemberTarget(requireNode(node.left))
  )
    throw unsupported("Arrays and objects are immutable; assign a new value instead.", requireNode(node.left), [
      "Loop with a fresh binding, e.g. for (const item of items) { ... }, and build a new value from it.",
    ])
  if (node.type === "UpdateExpression" && requireNode(node.argument).type === "MemberExpression")
    throw unsupported(
      "Arrays and objects are immutable; assign a new value instead.",
      node,
      Suggestions.memberAssignment(requireNode(node.argument), Suggestions.assignedValue(node)),
    )
  if (node.type === "UnaryExpression" && node.operator === "delete")
    throw unsupported(
      "Arrays and objects are immutable; delete is not supported.",
      node,
      Suggestions.deletion(node.argument),
    )
  if (node.type === "NewExpression") {
    const name = identifierName(node.callee)
    if (name === "Promise") throw unsupported(promiseUnsupported, node, promiseSuggestions)
    const removed = name === undefined ? undefined : removedGlobals.get(name)
    if (removed) throw unsupported(removed.message + ".", node, removed.suggestions)
  }
  if (node.type === "CallExpression") {
    const callee = requireNode(node.callee)
    const regex = Suggestions.regexCall(node)
    if (regex) throw unsupported(regexUnavailable + ".", regex.node, regex.suggestions)
    if (isPromiseAllCall(node)) {
      const args = requireArray(node.arguments, node)
      if (args.length !== 1) throw unsupported("Promise.all compatibility expects exactly one array argument.", node)
      const argument = requireNode(args[0])
      if (argument.type === "SpreadElement")
        throw unsupported("Promise.all compatibility does not support spread arguments; pass one array directly.", argument)
      validate(argument)
      return
    }
    const path = toolPath(callee)
    if (path !== undefined) {
      if (path.length === 0)
        throw unsupported("The tools root is not callable.", callee, [
          'Call a tool by its full path; tools.search({ query: "what you need" }) lists them.',
        ])
      for (const value of requireArray(node.arguments, node)) validate(requireNode(value))
      return
    }
    if (isToolDefine(callee)) {
      for (const value of requireArray(node.arguments, node)) validate(requireNode(value))
      return
    }
    const method = memberName(callee)
    if (method && mutatingMethods.has(method))
      throw unsupported(
        "Mutating method '" + method + "' is not supported; arrays and objects are immutable.",
        callee,
        Suggestions.mutatingMethod(method, callee, requireArray(node.arguments, node)),
      )
  }
  if (node.type === "Identifier" && node.name === "Promise")
    throw unsupported(promiseUnsupported, node, promiseSuggestions)
  if (node.type === "Identifier" && node.name === "tools")
    throw unsupported(
      "Tools must be called through a direct static path such as tools.fs.read(...).",
      node,
      Suggestions.dynamicTool,
    )
  if (node.type === "Identifier" && node.name === "tool")
    throw unsupported("The tool namespace only supports direct tool.define(...) calls.", node, [
      "Call it directly: let inspect = tool.define({ name, description, inputSchema, outputSchema, execute })",
    ])
  if (node.type === "Identifier" && typeof node.name === "string") {
    const removed = removedGlobals.get(node.name)
    if (removed) throw unsupported(removed.message + ".", node, removed.suggestions)
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === "loc") continue
    if (node.type === "Property" && key === "key" && node.computed !== true) continue
    if (node.type === "MemberExpression" && key === "property" && node.computed !== true) continue
    if (Array.isArray(value)) {
      for (const item of value) if (isRecord(item) && typeof item.type === "string") validate(item as AstNode)
      continue
    }
    if (isRecord(value) && typeof value.type === "string") validate(value as AstNode)
  }
}

function isToolDefine(value: AstNode) {
  if (value.type !== "MemberExpression" || value.optional === true || value.computed === true) return false
  const object = requireNode(value.object)
  const property = requireNode(value.property)
  return (
    object.type === "Identifier" &&
    object.name === "tool" &&
    property.type === "Identifier" &&
    property.name === "define"
  )
}

function toolPath(value: AstNode): ReadonlyArray<string> | undefined {
  if (value.type === "Identifier") return value.name === "tools" ? [] : undefined
  if (value.type !== "MemberExpression" || value.optional === true) return undefined
  const parent = toolPath(requireNode(value.object))
  if (parent === undefined) return undefined
  const property = requireNode(value.property)
  if (value.computed !== true && property.type === "Identifier" && typeof property.name === "string")
    return [...parent, property.name]
  if (value.computed === true && property.type === "Literal" && typeof property.value === "string")
    return [...parent, property.value]
  throw unsupported("Tool paths must use literal property names.", property, Suggestions.dynamicTool)
}

function memberName(value: AstNode): string | undefined {
  if (value.type !== "MemberExpression") return
  const property = requireNode(value.property)
  if (value.computed !== true && property.type === "Identifier" && typeof property.name === "string")
    return property.name
  if (value.computed === true && property.type === "Literal" && typeof property.value === "string")
    return property.value
}

function hasMemberTarget(node: AstNode): boolean {
  if (node.type === "MemberExpression") return true
  if (node.type === "AssignmentPattern" || node.type === "RestElement")
    return hasMemberTarget(requireNode(node.left ?? node.argument))
  if (node.type === "ArrayPattern")
    return requireArray(node.elements, node).some((value) => value !== null && hasMemberTarget(requireNode(value)))
  if (node.type === "ObjectPattern")
    return requireArray(node.properties, node).some((value) => {
      const property = requireNode(value)
      return hasMemberTarget(requireNode(property.type === "RestElement" ? property.argument : property.value))
    })
  return false
}

function identifierName(value: unknown): string | undefined {
  const node = requireNode(value)
  return node.type === "Identifier" && typeof node.name === "string" ? node.name : undefined
}

function requireNode(value: unknown): AstNode {
  if (!isRecord(value) || typeof value.type !== "string") throw new CompileError("Invalid compiler node.", "ParseError")
  return value as AstNode
}

function requireArray(value: unknown, node: AstNode): Array<unknown> {
  if (!Array.isArray(value)) throw new CompileError("Invalid compiler node list.", "ParseError", node)
  return value
}

function unsupported(
  message: string,
  node: AstNode,
  suggestions: ReadonlyArray<string> = [Suggestions.general],
): CompileError {
  return new CompileError(message, "UnsupportedSyntax", node, suggestions)
}
