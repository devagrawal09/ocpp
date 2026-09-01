import type { Effect } from "effect"
import type { SafeObject } from "../tool-runtime.js"
import type { CodeModePromise, CodeModeRegExp, CodeModeURL } from "../values.js"

export type SourcePosition = {
  line: number
  column: number
}

export type SourceLocation = {
  start: SourcePosition
  end: SourcePosition
}

export type AstNode = {
  type: string
  loc?: SourceLocation
  [key: string]: unknown
}

export type ProgramNode = AstNode & {
  type: "Program"
  body: Array<AstNode>
}

export type Binding = {
  mutable: boolean
  value: unknown
  initialized?: boolean
}

export type StatementResult =
  | { kind: "none" }
  | { kind: "return"; value: unknown }
  | { kind: "break"; label?: string }
  | { kind: "continue"; label?: string }

export type MemberReference = {
  target: SafeObject | Array<unknown> | CodeModeRegExp | CodeModeURL
  key: PropertyKey
}

export class CodeModeFunction {
  constructor(
    readonly parameters: ReadonlyArray<AstNode>,
    readonly body: AstNode,
    readonly capturedScopes: ReadonlyArray<Map<string, Binding>>,
    readonly async: boolean,
    readonly generator: boolean,
  ) {}
}

export type GeneratorRequestKind = "next" | "return" | "throw"

export class CodeModeGenerator {
  constructor(
    readonly asynchronous: boolean,
    readonly request: (
      kind: GeneratorRequestKind,
      value: unknown,
      node: AstNode,
    ) => Effect.Effect<unknown, unknown, unknown>,
  ) {}
}

export class GeneratorMethodReference {
  constructor(
    readonly generator: CodeModeGenerator,
    readonly kind: GeneratorRequestKind | "iterator",
  ) {}
}

export class IntrinsicReference {
  constructor(
    readonly receiver: unknown,
    readonly name: string,
  ) {}
}

export class ComputedValue {
  constructor(readonly value: unknown) {}
}

export class PromiseNamespace {}

export class ToolNamespace {
  readonly _tag = "ToolNamespace"
}

export class ToolDefineReference {
  readonly _tag = "ToolDefineReference"
}

export class SymbolNamespace {}

export const AsyncIteratorSymbol: unique symbol = Symbol("codemode.async-iterator")
export const IteratorSymbol: unique symbol = Symbol("codemode.iterator")
export const IteratorSymbols = [AsyncIteratorSymbol, IteratorSymbol] as const

export type PromiseMethodName = "all" | "allSettled" | "race" | "any" | "resolve" | "reject"

export class PromiseMethodReference {
  constructor(readonly name: PromiseMethodName) {}
}

export type PromiseInstanceMethodName = "then" | "catch" | "finally"

export class PromiseInstanceMethodReference {
  constructor(
    readonly promise: CodeModePromise,
    readonly name: PromiseInstanceMethodName,
  ) {}
}

export class PromiseCapabilityFunction {
  constructor(readonly settle: (value: unknown) => void) {}
}

export type GlobalNamespaceName =
  | "Object"
  | "Math"
  | "JSON"
  | "Array"
  | "console"
  | "Date"
  | "RegExp"
  | "Map"
  | "Set"
  | "URL"
  | "URLSearchParams"

export class GlobalNamespace {
  constructor(readonly name: GlobalNamespaceName) {}
}

export class GlobalMethodReference {
  constructor(
    readonly namespace: Exclude<GlobalNamespaceName, "JSON"> | "Number" | "String",
    readonly name: string,
  ) {}
}

export class JsonMethodReference {
  constructor(readonly name: "parse" | "stringify") {}
}

export class CoercionFunction {
  constructor(readonly name: "Number" | "String" | "Boolean" | "parseInt" | "parseFloat" | "isFinite" | "isNaN") {}
}

export class UriFunction {
  constructor(readonly name: "encodeURI" | "encodeURIComponent" | "decodeURI" | "decodeURIComponent") {}
}

export class SearchFunction {}

export class ProgramThrow {
  constructor(readonly value: unknown) {}
}

export class GeneratorReturn {
  constructor(readonly value: unknown) {}
}

export class ErrorConstructorReference {
  constructor(readonly name: string) {}
}

export type DiagnosticKind =
  | "ParseError"
  | "UnsupportedSyntax"
  | "UnknownTool"
  | "InvalidToolInput"
  | "InvalidToolOutput"
  | "InvalidDataValue"
  | "ToolCallLimitExceeded"
  | "TimeoutExceeded"
  | "ToolFailure"
  | "ExecutionFailure"
  | "RevisionConflict"

export const OptionalShortCircuit: unique symbol = Symbol("codemode.optional-short-circuit")

export const supportedSyntaxMessage =
  "Supported orchestration syntax: direct blocking tools.* calls, immutable data literals and transformations, activation-local let bindings, synchronous functions and callbacks, control flow, captured console output, and direct top-level export const publication. Promise, async, await, generators, dynamic tool dispatch, and aggregate mutation are not supported."

export class InterpreterRuntimeError extends Error {
  readonly node?: AstNode
  errorName = "Error"

  constructor(
    message: string,
    node?: AstNode,
    readonly kind: DiagnosticKind = "ExecutionFailure",
    readonly suggestions?: ReadonlyArray<string>,
  ) {
    super(message)
    this.name = "InterpreterRuntimeError"
    if (node) this.node = node
  }

  as(errorName: string): this {
    this.errorName = errorName
    return this
  }
}

export const unsupportedSyntax = (kind: string, node: AstNode): InterpreterRuntimeError =>
  new InterpreterRuntimeError(
    `Syntax '${kind}' is not supported. ${supportedSyntaxMessage}`,
    node,
    "UnsupportedSyntax",
    [supportedSyntaxMessage],
  )

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export const asNode = (value: unknown, context: string): AstNode => {
  if (!isRecord(value) || typeof value.type !== "string") {
    throw new InterpreterRuntimeError(`Invalid AST node while reading ${context}.`)
  }
  return value as AstNode
}

export const getArray = (node: AstNode, key: string): Array<unknown> => {
  const value = node[key]
  if (!Array.isArray(value)) throw new InterpreterRuntimeError(`Expected '${key}' to be an array.`, node)
  return value
}

export const getString = (node: AstNode, key: string): string => {
  const value = node[key]
  if (typeof value !== "string") throw new InterpreterRuntimeError(`Expected '${key}' to be a string.`, node)
  return value
}

export const getBoolean = (node: AstNode, key: string): boolean => {
  const value = node[key]
  if (typeof value !== "boolean") throw new InterpreterRuntimeError(`Expected '${key}' to be a boolean.`, node)
  return value
}

export const getOptionalNode = (node: AstNode, key: string): AstNode | undefined => {
  const value = node[key]
  if (value === undefined || value === null) return undefined
  return asNode(value, key)
}

export const getNode = (node: AstNode, key: string): AstNode => asNode(node[key], key)

export const sourceLocation = (node: AstNode): { readonly line: number; readonly column: number } => ({
  line: Math.max(1, (node.loc?.start.line ?? 2) - 1),
  column: Math.max(1, (node.loc?.start.column ?? 4) - 3),
})

export const formatLocation = (node?: AstNode): string => {
  if (!node?.loc) return ""
  const location = sourceLocation(node)
  return ` (line ${location.line}, col ${location.column})`
}
