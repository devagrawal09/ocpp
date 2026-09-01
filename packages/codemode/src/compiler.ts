import { parse } from "acorn"
import { transpile } from "#transpile"
import { InterpreterRuntimeError, isRecord, type AstNode, type ProgramNode } from "./interpreter/model.js"

export const IR_VERSION = 1 as const

export type Program = {
  readonly version: typeof IR_VERSION
  readonly source: string
  readonly body: ProgramNode
  readonly exports: ReadonlyArray<string>
}

const forbidden = new Map([
  ["AwaitExpression", "await is not supported; tool calls block and return their result directly"],
  ["YieldExpression", "generators are not supported"],
  ["ImportDeclaration", "imports are not supported"],
  ["ImportExpression", "dynamic imports are not supported"],
  ["ExportDefaultDeclaration", "default exports are not supported; use a top-level export const declaration"],
  ["ExportAllDeclaration", "re-exports are not supported"],
])

const mutatingMethods = new Set([
  "add",
  "assign",
  "clear",
  "copyWithin",
  "delete",
  "fill",
  "pop",
  "push",
  "reverse",
  "set",
  "shift",
  "sort",
  "splice",
  "unshift",
])

export function compile(code: string): Program {
  if (code.trim().length === 0) throw new InterpreterRuntimeError("Code cannot be empty.", undefined, "ParseError")
  const transpiled = transpile(code)
  if (transpiled.error !== undefined)
    throw new InterpreterRuntimeError("Failed to parse TypeScript: " + transpiled.error, undefined, "ParseError")

  const parsed = parse(transpiled.outputText, {
    ecmaVersion: "latest",
    sourceType: "module",
    allowReturnOutsideFunction: true,
    locations: true,
  }) as unknown
  if (!isRecord(parsed) || parsed.type !== "Program" || !Array.isArray(parsed.body))
    throw new InterpreterRuntimeError("Failed to compile script as a Program.", undefined, "ParseError")

  const exports: string[] = []
  const body = parsed.body.map((value) => {
    const node = requireNode(value)
    if (node.type !== "ExportNamedDeclaration") return node
    const declaration = requireNode(node.declaration)
    if (declaration.type !== "VariableDeclaration" || declaration.kind !== "const")
      throw unsupported("Exports must be direct top-level export const declarations.", node)
    for (const value of requireArray(declaration.declarations, declaration)) {
      const item = requireNode(value)
      const id = requireNode(item.id)
      if (id.type !== "Identifier" || typeof id.name !== "string")
        throw unsupported("Export declarations must bind one identifier without destructuring.", id)
      if (item.init === undefined || item.init === null)
        throw unsupported("Export '" + id.name + "' requires an initializer.", item)
      exports.push(id.name)
    }
    return declaration
  })
  const program = { ...(parsed as ProgramNode), body }
  validate(program)
  return { version: IR_VERSION, source: transpiled.outputText, body: program, exports }
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
  if (node.type === "NewExpression" && identifierName(node.callee) === "Promise")
    throw unsupported("Promise is not supported; tool calls block and return their result directly.", node)
  if (node.type === "CallExpression") {
    const callee = requireNode(node.callee)
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
    if (method && (mutatingMethods.has(method) || method.startsWith("setUTC") || /^set[A-Z]/.test(method)))
      throw unsupported("Mutating method '" + method + "' is not supported; arrays and objects are immutable.", callee)
  }
  if (node.type === "Identifier" && node.name === "Promise")
    throw unsupported("Promise is not supported; tool calls block and return their result directly.", node)
  if (node.type === "Identifier" && node.name === "tools")
    throw unsupported("Tools must be called through a direct static path such as tools.fs.read(...).", node)
  if (node.type === "Identifier" && node.name === "tool")
    throw unsupported("The tool namespace only supports direct tool.define(...) calls.", node)

  for (const [key, value] of Object.entries(node)) {
    if (key === "loc") continue
    if (node.type === "Property" && key === "key" && node.computed !== true) continue
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
  if (!isRecord(value) || typeof value.type !== "string") throw new InterpreterRuntimeError("Invalid compiler node.")
  return value as AstNode
}

function requireArray(value: unknown, node: AstNode): Array<unknown> {
  if (!Array.isArray(value)) throw new InterpreterRuntimeError("Invalid compiler node list.", node)
  return value
}

function unsupported(message: string, node: AstNode): InterpreterRuntimeError {
  return new InterpreterRuntimeError(message, node, "UnsupportedSyntax", [
    "Use synchronous functions, direct blocking tool calls, immutable data transformations, and top-level export const declarations.",
  ])
}
