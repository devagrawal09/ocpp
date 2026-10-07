import { type AstNode, isRecord, type ProgramNode, staticToolPath } from "./ir.js"

/**
 * Speculation plan: pure, data-only metadata about which tool calls a program's top-level statements
 * make, so a host can start read-only calls before the program reaches them. It knows nothing about
 * tools beyond their static paths; whether a call may run early is the host's decision.
 */

/** A direct tool call that a top-level statement always makes once the statement runs, in run order. */
export type PlannedCall = {
  /** Index of the top-level statement in the program body. */
  readonly statement: number
  /** Canonical dotted tool path, such as `fs.read`. */
  readonly path: string
  /** The single argument expression, or undefined when the call does not pass exactly one argument. */
  readonly argument: AstNode | undefined
  /** Free identifiers the argument reads. */
  readonly reads: ReadonlyArray<string>
}

export type PlannedStatement = {
  readonly index: number
  /**
   * True when the statement may run code or tool calls the analysis cannot see, such as a user or
   * notebook function, an impure helper, an iterator, a loop, or a conditional tool call. Speculation
   * never looks past an opaque statement.
   */
  readonly opaque: boolean
  /** Every tool call the statement makes, in run order. Empty when opaque. */
  readonly calls: ReadonlyArray<PlannedCall>
  /** Existing bindings the statement assigns, so a later call that reads one is not evaluated early. */
  readonly writes: ReadonlyArray<string>
}

export type SpeculationPlan = {
  readonly statements: ReadonlyArray<PlannedStatement>
}

/** Thrown inside the analysis when a statement is opaque. */
class Opaque {}
const opaque = new Opaque()

/** Error constructors that build a plain error value and run no program code. */
const errorConstructors = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
])

const isNode = (value: unknown): value is AstNode => isRecord(value) && typeof value.type === "string"

const node = (value: unknown): AstNode => {
  if (!isNode(value)) throw opaque
  return value
}

const nodes = (value: unknown): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) throw opaque
  return value
}

type Analysis = { readonly calls: Array<PlannedCall>; readonly writes: Array<string>; readonly statement: number }

/** Plans every top-level statement of a program. Pure: the same program always gives the same plan. */
export const plan = (program: ProgramNode): SpeculationPlan => ({
  statements: program.body.map((statement, index) => planStatement(statement, index)),
})

const planStatement = (statement: AstNode, index: number): PlannedStatement => {
  const analysis: Analysis = { calls: [], writes: [], statement: index }
  try {
    visitStatement(statement, analysis, false)
    return { index, opaque: false, calls: analysis.calls, writes: analysis.writes }
  } catch (error) {
    if (error instanceof Opaque) return { index, opaque: true, calls: [], writes: [] }
    throw error
  }
}

/**
 * A statement is transparent only when it is made of forms whose every effect the analysis sees. In a
 * conditional position (an if branch) no tool call is allowed, since whether it runs is unknown.
 */
const visitStatement = (statement: AstNode, analysis: Analysis, conditional: boolean): void => {
  switch (statement.type) {
    case "EmptyStatement":
    case "FunctionDeclaration":
      return
    case "ExpressionStatement":
      return visitExpression(node(statement.expression), analysis, conditional)
    case "ReturnStatement":
    case "ThrowStatement":
      if (statement.argument !== null && statement.argument !== undefined)
        visitExpression(node(statement.argument), analysis, conditional)
      return
    case "VariableDeclaration": {
      if (statement.kind !== "const" && statement.kind !== "let") throw opaque
      for (const declarator of nodes(statement.declarations)) {
        const current = node(declarator)
        if (current.init !== null && current.init !== undefined)
          visitExpression(node(current.init), analysis, conditional)
        visitPattern(node(current.id), analysis, conditional)
      }
      return
    }
    case "IfStatement":
      visitExpression(node(statement.test), analysis, conditional)
      visitStatement(node(statement.consequent), analysis, true)
      if (statement.alternate !== null && statement.alternate !== undefined)
        visitStatement(node(statement.alternate), analysis, true)
      return
    case "BlockStatement":
      for (const item of nodes(statement.body)) visitStatement(node(item), analysis, conditional)
      return
    default:
      throw opaque
  }
}

/** Declaration patterns. Array patterns run the iterator protocol, which may call program code. */
const visitPattern = (pattern: AstNode, analysis: Analysis, conditional: boolean): void => {
  switch (pattern.type) {
    case "Identifier":
      return
    case "ObjectPattern":
      for (const item of nodes(pattern.properties)) {
        const property = node(item)
        if (property.type === "RestElement") {
          visitPattern(node(property.argument), analysis, conditional)
          continue
        }
        if (property.type !== "Property") throw opaque
        if (property.computed === true) visitExpression(node(property.key), analysis, conditional)
        visitPattern(node(property.value), analysis, conditional)
      }
      return
    case "AssignmentPattern":
      visitPattern(node(pattern.left), analysis, conditional)
      // A default runs only when the value is undefined.
      return visitExpression(node(pattern.right), analysis, true)
    default:
      throw opaque
  }
}

const visitExpression = (expression: AstNode, analysis: Analysis, conditional: boolean): void => {
  switch (expression.type) {
    case "Literal":
    case "Identifier":
    case "ArrowFunctionExpression":
    case "FunctionExpression":
      // Creating a function runs none of its body.
      return
    case "TemplateLiteral":
      for (const item of nodes(expression.expressions)) visitExpression(node(item), analysis, conditional)
      return
    case "BinaryExpression":
      visitExpression(node(expression.left), analysis, conditional)
      return visitExpression(node(expression.right), analysis, conditional)
    case "LogicalExpression":
      visitExpression(node(expression.left), analysis, conditional)
      return visitExpression(node(expression.right), analysis, true)
    case "ConditionalExpression":
      visitExpression(node(expression.test), analysis, conditional)
      visitExpression(node(expression.consequent), analysis, true)
      return visitExpression(node(expression.alternate), analysis, true)
    case "UnaryExpression":
      if (expression.operator === "delete") throw opaque
      return visitExpression(node(expression.argument), analysis, conditional)
    case "SequenceExpression":
      for (const item of nodes(expression.expressions)) visitExpression(node(item), analysis, conditional)
      return
    case "AwaitExpression":
      return visitExpression(node(expression.argument), analysis, conditional)
    case "ChainExpression":
      // Anything after an optional link may be skipped.
      return visitExpression(node(expression.expression), analysis, true)
    case "MemberExpression":
      visitExpression(node(expression.object), analysis, conditional)
      if (expression.computed === true)
        visitExpression(node(expression.property), analysis, conditional || expression.optional === true)
      return
    case "ObjectExpression":
      for (const item of nodes(expression.properties)) {
        const property = node(item)
        if (property.type === "SpreadElement") {
          visitExpression(node(property.argument), analysis, conditional)
          continue
        }
        if (property.type !== "Property" || property.kind !== "init") throw opaque
        if (property.computed === true) visitExpression(node(property.key), analysis, conditional)
        visitExpression(node(property.value), analysis, conditional)
      }
      return
    case "ArrayExpression":
      for (const item of nodes(expression.elements)) {
        if (item === null) continue
        const element = node(item)
        // Array spread runs the iterator protocol, which may call program code.
        if (element.type === "SpreadElement") throw opaque
        visitExpression(element, analysis, conditional)
      }
      return
    case "AssignmentExpression": {
      const target = node(expression.left)
      if (target.type !== "Identifier" || typeof target.name !== "string") throw opaque
      const operator = String(expression.operator)
      visitExpression(
        node(expression.right),
        analysis,
        conditional || operator === "&&=" || operator === "||=" || operator === "??=",
      )
      analysis.writes.push(target.name)
      return
    }
    case "UpdateExpression": {
      const target = node(expression.argument)
      if (target.type !== "Identifier" || typeof target.name !== "string") throw opaque
      analysis.writes.push(target.name)
      return
    }
    case "NewExpression": {
      const callee = node(expression.callee)
      if (callee.type !== "Identifier" || typeof callee.name !== "string" || !errorConstructors.has(callee.name))
        throw opaque
      for (const item of nodes(expression.arguments)) {
        const argument = node(item)
        if (argument.type === "SpreadElement") throw opaque
        visitExpression(argument, analysis, conditional)
      }
      return
    }
    case "CallExpression": {
      if (expression.optional === true) throw opaque
      const path = staticToolPath(node(expression.callee))
      // Any other call may run program code: a user or notebook function, a method with a callback,
      // or an impure helper such as time.now() or Math.random().
      if (path === undefined || path.length === 0) throw opaque
      const args = nodes(expression.arguments).map(node)
      if (args.some((argument) => argument.type === "SpreadElement")) throw opaque
      // Arguments run before the call itself.
      for (const argument of args) visitExpression(argument, analysis, conditional)
      if (conditional) throw opaque
      const argument = args.length === 1 ? args[0] : undefined
      analysis.calls.push({
        statement: analysis.statement,
        path: path.join("."),
        argument,
        reads: argument === undefined ? [] : [...new Set(reads(argument))],
      })
      return
    }
    default:
      throw opaque
  }
}

/** Identifiers an expression reads. Function bodies are skipped: early evaluation refuses functions. */
const reads = (expression: AstNode): ReadonlyArray<string> => {
  switch (expression.type) {
    case "Identifier":
      return typeof expression.name === "string" ? [expression.name] : []
    case "ArrowFunctionExpression":
    case "FunctionExpression":
      return []
    case "MemberExpression":
      return [
        ...reads(node(expression.object)),
        ...(expression.computed === true ? reads(node(expression.property)) : []),
      ]
    case "Property":
      return [...(expression.computed === true ? reads(node(expression.key)) : []), ...reads(node(expression.value))]
    default:
      return Object.entries(expression).flatMap(([key, value]) =>
        key === "loc" ? [] : (Array.isArray(value) ? value : [value]).filter(isNode).flatMap(reads),
      )
  }
}
