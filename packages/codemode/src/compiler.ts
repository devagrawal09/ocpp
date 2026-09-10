import { parse } from "acorn"
import { transpile } from "#transpile"
import { reservedNames } from "./globals.js"
import { IR_VERSION, isPromiseAllCall, isRecord, type AstNode, type Program, type ProgramNode } from "./ir.js"

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
  ) {
    super(message)
    this.name = "CompileError"
  }
}

const forbidden = new Map([
  ["YieldExpression", "generators are not supported"],
  ["ImportDeclaration", "imports are not supported"],
  ["ImportExpression", "dynamic imports are not supported"],
  [
    "ExportNamedDeclaration",
    "export is not supported; direct top-level const and function declarations are published automatically",
  ],
  [
    "ExportDefaultDeclaration",
    "export is not supported; direct top-level const and function declarations are published automatically",
  ],
  ["ExportAllDeclaration", "re-exports are not supported"],
])

// Removed language values whose helper replacements return plain durable data.
const removedGlobals = new Map([
  ["Date", "Date is not a value; use time.now(), time.parse(text), time.add(...), and time.format(...)"],
  ["Map", "Map is not a value; use immutable records and arrays"],
  ["Set", "Set is not a value; use immutable arrays"],
  ["URL", "URL is not a value; use url.parse(text) and url.format(record)"],
  ["URLSearchParams", "URLSearchParams is not a value; use url.parse(text).query and url.formatQuery(record)"],
  // Pattern matching is unavailable until the runtime has an engine whose cost is bounded by input
  // length. A backtracking matcher blocks the host, so no partial pattern support is offered.
  [
    "RegExp",
    "Regular expressions are not available; match text with string methods such as includes, startsWith, indexOf, slice, and split",
  ],
  [
    "regex",
    "Regular expressions are not available; match text with string methods such as includes, startsWith, indexOf, slice, and split",
  ],
])

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
    throw new CompileError("Failed to parse TypeScript: " + transpiled.error, "ParseError")

  const parsed = parse(transpiled.outputText, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowReturnOutsideFunction: true,
    locations: true,
  }) as unknown
  if (!isRecord(parsed) || parsed.type !== "Program" || !Array.isArray(parsed.body))
    throw new CompileError("Failed to compile script as a Program.", "ParseError")

  const program = parsed as ProgramNode
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
        )
      const init = item.init
      if (init === undefined || init === null)
        throw unsupported("Top-level const '" + id.name + "' requires an initializer.", item)
      // Handles exist only for one execution, so catch the natural const form before anything runs.
      if (requireNode(init).type === "CallExpression" && isToolDefine(requireNode(requireNode(init).callee)))
        throw unsupported(
          "Tool handles are activation-local and cannot be saved; bind '" +
            id.name +
            "' with let, or create the handle inside a function.",
          item,
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
    )
  return name
}

function validate(node: AstNode): void {
  const message = forbidden.get(node.type)
  if (message) throw unsupported(message, node)
  if (
    (node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression") &&
    (node.async === true || node.generator === true)
  )
    throw unsupported("Async functions and generators are not supported.", node)
  if (node.type === "ForOfStatement" && node.await === true) throw unsupported("for await...of is not supported.", node)
  if (node.type === "VariableDeclaration" && node.kind === "var")
    throw unsupported("var is not supported; use activation-local let or immutable const.", node)
  if (node.type === "Literal" && isRecord(node.regex))
    throw unsupported(
      "Regular expressions are not available; match text with string methods such as includes, startsWith, indexOf, slice, and split.",
      node,
    )
  if (node.type === "AssignmentExpression") {
    const left = requireNode(node.left)
    if (hasMemberTarget(left)) throw unsupported("Arrays and objects are immutable; assign a new value instead.", left)
  }
  if (
    (node.type === "ForOfStatement" || node.type === "ForInStatement") &&
    requireNode(node.left).type !== "VariableDeclaration" &&
    hasMemberTarget(requireNode(node.left))
  )
    throw unsupported("Arrays and objects are immutable; assign a new value instead.", requireNode(node.left))
  if (node.type === "UpdateExpression" && requireNode(node.argument).type === "MemberExpression")
    throw unsupported("Arrays and objects are immutable; assign a new value instead.", node)
  if (node.type === "UnaryExpression" && node.operator === "delete")
    throw unsupported("Arrays and objects are immutable; delete is not supported.", node)
  if (node.type === "NewExpression") {
    const name = identifierName(node.callee)
    if (name === "Promise")
      throw unsupported("Promise is not supported; tool calls block and return their result directly.", node)
    const removed = name === undefined ? undefined : removedGlobals.get(name)
    if (removed) throw unsupported(removed + ".", node)
  }
  if (node.type === "CallExpression") {
    const callee = requireNode(node.callee)
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
      if (path.length === 0) throw unsupported("The tools root is not callable.", callee)
      for (const value of requireArray(node.arguments, node)) validate(requireNode(value))
      return
    }
    if (isToolDefine(callee)) {
      for (const value of requireArray(node.arguments, node)) validate(requireNode(value))
      return
    }
    const method = memberName(callee)
    if (method && mutatingMethods.has(method))
      throw unsupported("Mutating method '" + method + "' is not supported; arrays and objects are immutable.", callee)
  }
  if (node.type === "Identifier" && node.name === "Promise")
    throw unsupported("Promise is not supported; tool calls block and return their result directly.", node)
  if (node.type === "Identifier" && node.name === "tools")
    throw unsupported("Tools must be called through a direct static path such as tools.fs.read(...).", node)
  if (node.type === "Identifier" && node.name === "tool")
    throw unsupported("The tool namespace only supports direct tool.define(...) calls.", node)
  if (node.type === "Identifier" && typeof node.name === "string") {
    const removed = removedGlobals.get(node.name)
    if (removed) throw unsupported(removed + ".", node)
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
  throw unsupported("Tool paths must use literal property names.", property)
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

function unsupported(message: string, node: AstNode): CompileError {
  return new CompileError(message, "UnsupportedSyntax", node, [
    "Use synchronous functions, direct blocking tool calls, and immutable data. Direct top-level const and function declarations publish durable notebook names automatically.",
  ])
}
