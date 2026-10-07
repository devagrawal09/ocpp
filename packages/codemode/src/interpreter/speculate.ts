import type { AstNode } from "../ir.js"
import { isBlockedMember } from "../tool-runtime.js"
import { MAX_COLLECTION_ITEMS, MAX_STRING_LENGTH } from "../limits.js"

/**
 * Side-effect-free evaluation of a tool call argument before the program reaches the call. It covers
 * only plain data forms: literals, bound identifiers, member reads on data, object and array literals,
 * templates, and operators on primitives. It never calls anything, so it cannot run a tool, program
 * code, an impure helper, or console output, and it never writes to scope or emits a trace. Anything
 * outside that subset refuses, and a refusal only means the call is not started early.
 */
export const refused: unique symbol = Symbol("speculation refused")
export type Refused = typeof refused

/** How evaluation reads a binding: undefined when it is missing, uninitialized, or unreadable. */
export type BindingReader = (name: string) => { readonly value: unknown } | undefined

class Refusal {}
const refusal = new Refusal()

export const evaluateSpeculatively = (expression: AstNode, read: BindingReader): unknown => {
  try {
    return evaluate(expression, read)
  } catch (error) {
    if (error instanceof Refusal) return refused
    throw error
  }
}

const refuse = (): never => {
  throw refusal
}

type Primitive = string | number | boolean | null | undefined

const isPrimitive = (value: unknown): value is Primitive =>
  value === null ||
  value === undefined ||
  typeof value === "string" ||
  typeof value === "number" ||
  typeof value === "boolean"

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

const bounded = (value: string): string => (value.length > MAX_STRING_LENGTH ? refuse() : value)

const child = (expression: AstNode, key: string): AstNode => {
  const value = expression[key]
  if (value === null || typeof value !== "object" || typeof (value as AstNode).type !== "string") return refuse()
  return value as AstNode
}

const list = (expression: AstNode, key: string): ReadonlyArray<unknown> => {
  const value = expression[key]
  return Array.isArray(value) ? value : refuse()
}

const propertyKey = (value: unknown): string => {
  if (typeof value === "string") return value
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return refuse()
}

const evaluate = (expression: AstNode, read: BindingReader): unknown => {
  switch (expression.type) {
    case "Literal": {
      if ("regex" in expression || "bigint" in expression) return refuse()
      const value = expression.value
      return isPrimitive(value) ? (typeof value === "string" ? bounded(value) : value) : refuse()
    }
    case "Identifier": {
      const binding = typeof expression.name === "string" ? read(expression.name) : undefined
      return binding === undefined ? refuse() : binding.value
    }
    case "AwaitExpression":
      return evaluate(child(expression, "argument"), read)
    case "TemplateLiteral": {
      const quasis = list(expression, "quasis")
      const expressions = list(expression, "expressions")
      let text = ""
      for (const [index, quasi] of quasis.entries()) {
        const cooked = (quasi as { value?: { cooked?: unknown } }).value?.cooked
        if (typeof cooked !== "string") return refuse()
        text = bounded(text + cooked)
        if (index >= expressions.length) continue
        const value = evaluate(expressions[index] as AstNode, read)
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return refuse()
        text = bounded(text + String(value))
      }
      return text
    }
    case "BinaryExpression": {
      const left = evaluate(child(expression, "left"), read)
      const right = evaluate(child(expression, "right"), read)
      if (!isPrimitive(left) || !isPrimitive(right)) return refuse()
      return binary(String(expression.operator), left, right)
    }
    case "LogicalExpression": {
      const left = evaluate(child(expression, "left"), read)
      switch (expression.operator) {
        case "&&":
          return truthy(left) ? evaluate(child(expression, "right"), read) : left
        case "||":
          return truthy(left) ? left : evaluate(child(expression, "right"), read)
        case "??":
          return left === null || left === undefined ? evaluate(child(expression, "right"), read) : left
        default:
          return refuse()
      }
    }
    case "ConditionalExpression":
      return truthy(evaluate(child(expression, "test"), read))
        ? evaluate(child(expression, "consequent"), read)
        : evaluate(child(expression, "alternate"), read)
    case "UnaryExpression": {
      const value = evaluate(child(expression, "argument"), read)
      if (expression.operator === "!") return !truthy(value)
      if (!isPrimitive(value)) return refuse()
      switch (expression.operator) {
        case "-":
          return -(value as number)
        case "+":
          return +(value as number)
        case "typeof":
          return typeof value
        case "void":
          return undefined
        default:
          return refuse()
      }
    }
    case "MemberExpression": {
      if (expression.optional === true) return refuse()
      const object = evaluate(child(expression, "object"), read)
      const property = child(expression, "property")
      const key =
        expression.computed === true
          ? propertyKey(evaluate(property, read))
          : property.type === "Identifier" && typeof property.name === "string"
            ? property.name
            : refuse()
      return member(object, key)
    }
    case "ObjectExpression": {
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
      let size = 0
      for (const item of list(expression, "properties")) {
        const property = item as AstNode
        if (property.type === "SpreadElement") {
          const spread = evaluate(child(property, "argument"), read)
          if (spread === null || spread === undefined) continue
          if (!isPlainRecord(spread)) return refuse()
          for (const [key, value] of Object.entries(spread)) {
            if (isBlockedMember(key) || ++size > MAX_COLLECTION_ITEMS) return refuse()
            result[key] = value
          }
          continue
        }
        if (property.type !== "Property" || property.kind !== "init" || property.method === true) return refuse()
        const keyNode = child(property, "key")
        const key =
          property.computed === true
            ? propertyKey(evaluate(keyNode, read))
            : keyNode.type === "Identifier" && typeof keyNode.name === "string"
              ? keyNode.name
              : keyNode.type === "Literal"
                ? propertyKey(keyNode.value)
                : refuse()
        if (isBlockedMember(key) || ++size > MAX_COLLECTION_ITEMS) return refuse()
        result[key] = evaluate(child(property, "value"), read)
      }
      return result
    }
    case "ArrayExpression": {
      const elements = list(expression, "elements")
      if (elements.length > MAX_COLLECTION_ITEMS) return refuse()
      return elements.map((element) =>
        element === null || (element as AstNode).type === "SpreadElement"
          ? refuse()
          : evaluate(element as AstNode, read),
      )
    }
    default:
      return refuse()
  }
}

const truthy = (value: unknown): boolean =>
  isPrimitive(value) ? Boolean(value) : isPlainRecord(value) || Array.isArray(value) ? true : refuse()

const binary = (operator: string, left: Primitive, right: Primitive): unknown => {
  switch (operator) {
    case "===":
      return left === right
    case "!==":
      return left !== right
    case "==":
      return left == right
    case "!=":
      return left != right
    case "+": {
      const value = (left as string) + (right as string)
      return typeof value === "string" ? bounded(value) : value
    }
    case "-":
      return (left as number) - (right as number)
    case "*":
      return (left as number) * (right as number)
    case "/":
      return (left as number) / (right as number)
    case "%":
      return (left as number) % (right as number)
    case "<":
      return (left as number) < (right as number)
    case "<=":
      return (left as number) <= (right as number)
    case ">":
      return (left as number) > (right as number)
    case ">=":
      return (left as number) >= (right as number)
    default:
      return refuse()
  }
}

/** Reads own data only; anything that would reach a method, an intrinsic, or a missing key refuses. */
const member = (object: unknown, key: string): unknown => {
  if (isBlockedMember(key)) return refuse()
  if (typeof object === "string" || Array.isArray(object)) {
    if (key === "length") return object.length
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || index >= object.length || String(index) !== key) return refuse()
    return object[index]
  }
  if (isPlainRecord(object) && Object.hasOwn(object, key)) return object[key]
  return refuse()
}
