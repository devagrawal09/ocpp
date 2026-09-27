export * as Suggestions from "./suggestions.js"

import { isRecord, type AstNode } from "./ir.js"

/**
 * Concrete rewrites for rejected syntax. Each suggestion is one line naming the supported
 * replacement, and it reuses the rejected code's own names where they are simple enough to render,
 * so the model can apply it directly instead of guessing what the subset allows.
 */

export const general =
  "Use synchronous functions, direct blocking tool calls, and immutable data. Direct top-level const and function declarations publish durable notebook names automatically."

export const regex = (text = "text") => [
  "Test " +
    text +
    " with " +
    text +
    '.includes("error"), ' +
    text +
    '.startsWith("id-"), or ' +
    text +
    '.endsWith(".ts")',
  "Extract parts with " + text + '.split(":"), ' + text + '.indexOf("="), and ' + text + ".slice(start, end)",
]

export const dynamicTool = [
  'Find the exact path with tools.search({ query: "what the tool does" }), then call that path directly in the next execution, e.g. tools.fs.read({ path }).',
  'To choose between known tools, branch explicitly: mode === "read" ? tools.fs.read(input) : tools.fs.write(input).',
]

export const immutable =
  "Create an updated copy with spread, such as { ...record, key: value } or [...items, item], instead of changing a value in place."

/** A rejected call that uses a regular expression, with rewrites that use string methods instead. */
export function regexCall(
  call: AstNode,
): { readonly node: AstNode; readonly suggestions: ReadonlyArray<string> } | undefined {
  const callee = asNode(call.callee)
  if (callee?.type !== "MemberExpression" || callee.computed === true) return
  const method = identifier(callee.property)
  const args = Array.isArray(call.arguments) ? call.arguments : []
  const receiver = asNode(callee.object)
  if (receiver && isRegex(receiver) && (method === "test" || method === "exec"))
    return { node: receiver, suggestions: regexRewrite(method, receiver, args[0], undefined) }
  const first = asNode(args[0])
  if (
    first &&
    isRegex(first) &&
    method !== undefined &&
    ["replace", "replaceAll", "split", "match", "matchAll", "search"].includes(method)
  )
    return { node: first, suggestions: regexRewrite(method, first, receiver, args[1]) }
}

/** Rewrites for top-level `const { a, b } = value`: one durable name per value, or local `let`. */
export function destructuring(pattern: AstNode, init: unknown): ReadonlyArray<string> {
  const bindings = patternBindings(pattern)
  if (bindings === undefined)
    return [
      "Save one name per value, e.g. const result = ...; const first = result.first",
      "Or destructure with let, which keeps the values for this execution only: let { first, second } = result",
    ]
  const value = source(init) ?? "..."
  const holder =
    ["result", "value", "data"].find((name) => !bindings.some((binding) => binding.name === name)) ?? "source"
  const text =
    pattern.type === "ArrayPattern"
      ? "[" + bindings.map((binding) => binding.text).join(", ") + "]"
      : "{ " + bindings.map((binding) => binding.text).join(", ") + " }"
  return [
    "Save one name per value: const " +
      holder +
      " = " +
      value +
      "; " +
      bindings
        .filter((binding) => binding.name !== "")
        .map((binding) => "const " + binding.name + " = " + holder + binding.access)
        .join("; "),
    "Or keep them for this execution only with let: let " + text + " = " + value,
  ]
}

/** Replacements for a mutating Array or Object method, applied to the receiver the model wrote. */
export function mutatingMethod(method: string, callee: AstNode, args: ReadonlyArray<unknown>): ReadonlyArray<string> {
  const items = source(callee.object) ?? "items"
  const values = args.map((arg) => source(arg) ?? "item").join(", ") || "item"
  if (method === "push")
    return [
      "Build a new array instead: " +
        items +
        " = [..." +
        items +
        ", " +
        values +
        "] for a let binding, or const next = [..." +
        items +
        ", " +
        values +
        "]",
    ]
  if (method === "unshift") return ["Build a new array instead: [" + values + ", ..." + items + "]"]
  if (method === "pop")
    return ["Read the last item with " + items + ".at(-1) and keep the rest with " + items + ".slice(0, -1)"]
  if (method === "shift")
    return ["Read the first item with " + items + "[0] and keep the rest with " + items + ".slice(1)"]
  if (method === "splice")
    return ["Use " + items + ".toSpliced(start, deleteCount, ...inserted), which returns a new array"]
  if (method === "sort")
    return ["Use " + items + ".toSorted(...) with the same comparator; it returns a new sorted array"]
  if (method === "reverse") return ["Use " + items + ".toReversed(), which returns a new array"]
  if (method === "fill") return ["Build the array directly: Array.from({ length: " + items + ".length }, () => value)"]
  if (method === "assign")
    return ["Merge into a new record: { " + args.map((arg) => "..." + (source(arg) ?? "record")).join(", ") + " }"]
  return [immutable]
}

/** A rewrite for assigning into a member, given the value the assignment would store. */
export function memberAssignment(target: AstNode, value: string): ReadonlyArray<string> {
  if (target.type !== "MemberExpression") return [immutable]
  const object = source(target.object) ?? "record"
  const property = asNode(target.property)
  if (target.computed !== true && property?.type === "Identifier")
    return [
      "Create an updated copy: { ..." +
        object +
        ", " +
        property.name +
        ": " +
        value +
        " }, kept in a let binding or a new const",
    ]
  const key = source(property) ?? "key"
  return [
    "Create an updated copy: " +
      object +
      ".with(" +
      key +
      ", " +
      value +
      ") for an array, or { ..." +
      object +
      ", [" +
      key +
      "]: " +
      value +
      " } for a record",
  ]
}

/** The value a compound assignment or update would store, rendered from the model's own code. */
export function assignedValue(node: AstNode): string {
  if (node.type === "UpdateExpression")
    return (source(node.argument) ?? "value") + (node.operator === "--" ? " - 1" : " + 1")
  const right = source(node.right) ?? "value"
  if (node.operator === "=" || typeof node.operator !== "string") return right
  return (source(node.left) ?? "value") + " " + node.operator.slice(0, -1) + " " + right
}

/** A rewrite for `delete record.key`: a copy that omits the key. */
export function deletion(argument: unknown): ReadonlyArray<string> {
  const target = asNode(argument)
  const property = asNode(target?.property)
  if (target?.type !== "MemberExpression" || property === undefined) return [immutable]
  const key = target.computed === true ? (source(property) ?? "key") : JSON.stringify(identifier(property) ?? "key")
  return [
    "Omit the key in a copy: Object.fromEntries(Object.entries(" +
      (source(target.object) ?? "record") +
      ").filter(([key]) => key !== " +
      key +
      "))",
  ]
}

function regexRewrite(method: string, literal: AstNode, subject: unknown, replacement: unknown): ReadonlyArray<string> {
  const pattern = isRecord(literal.regex) ? literal.regex : {}
  const body = typeof pattern.pattern === "string" ? pattern.pattern : ""
  const flags = typeof pattern.flags === "string" ? pattern.flags : ""
  const text = source(subject) ?? "text"
  const plain = literalPattern(body, flags)
  const exact = plain && !plain.start && !plain.end && !plain.ignoreCase ? JSON.stringify(plain.text) : undefined
  if (method === "split") {
    if (["\\s+", "\\s*", "\\s", " +"].includes(body))
      return ["Split on single spaces and drop empty parts: " + text + '.split(" ").filter((part) => part !== "")']
    if (body === "\\n" || body === "\\r?\\n") return ["Split lines with a string separator: " + text + '.split("\\n")']
    if (exact) return ["Use a string separator: " + text + ".split(" + exact + ")"]
    return ["Split on a fixed string, e.g. " + text + '.split(","), then trim or filter the parts']
  }
  if (method === "replace" || method === "replaceAll") {
    const value = source(replacement) ?? "replacement"
    if (exact)
      return [
        "Use a string pattern: " +
          text +
          "." +
          (plain?.global || method === "replaceAll" ? "replaceAll" : "replace") +
          "(" +
          exact +
          ", " +
          value +
          ")",
      ]
    return ["Replace fixed text with a string pattern, e.g. " + text + '.replaceAll("\\t", " ")']
  }
  if (plain === undefined) {
    const prefix = literalPrefix(body)
    if (method === "test" || prefix.length < 2) return regex(text)
    const found = text + ".indexOf(" + JSON.stringify(prefix) + ")"
    return [
      "Find the fixed text with " +
        found +
        ", read what follows with " +
        text +
        ".slice(" +
        found +
        " + " +
        prefix.length +
        "), and cut it with split or indexOf",
    ]
  }
  const subjectText = plain.ignoreCase ? text + ".toLowerCase()" : text
  const needle = JSON.stringify(plain.ignoreCase ? plain.text.toLowerCase() : plain.text)
  if (method === "test")
    return [
      "Replace /" +
        body +
        "/" +
        flags +
        ".test(" +
        text +
        ") with " +
        (plain.start && plain.end
          ? subjectText + " === " + needle
          : plain.start
            ? subjectText + ".startsWith(" + needle + ")"
            : plain.end
              ? subjectText + ".endsWith(" + needle + ")"
              : subjectText + ".includes(" + needle + ")"),
    ]
  return [
    "Use " +
      subjectText +
      ".includes(" +
      needle +
      ") to test for the text, or " +
      subjectText +
      ".indexOf(" +
      needle +
      ") to find where it starts",
  ]
}

// A pattern without metacharacters matches one literal string, so it has an exact string-method
// rewrite. Escaped punctuation is literal text; any other escape, such as \d, is a real pattern.
function literalPattern(pattern: string, flags: string) {
  if ([...flags].some((flag) => !"giu".includes(flag))) return
  const start = pattern.startsWith("^")
  const end = pattern.endsWith("$") && !pattern.endsWith("\\$")
  const body = pattern.slice(start ? 1 : 0, end ? -1 : pattern.length)
  if (!/^(?:[^\\^$.*+?()[\]{}|]|\\[^A-Za-z0-9])+$/.test(body)) return
  return {
    text: body.replace(/\\(.)/g, "$1"),
    start,
    end,
    global: flags.includes("g"),
    ignoreCase: flags.includes("i"),
  }
}

// The literal text a pattern starts with. A quantifier after the last character makes that character
// optional or repeated, so it is left out.
function literalPrefix(pattern: string) {
  const prefix = /^\^?((?:[^\\^$.*+?()[\]{}|]|\\[^A-Za-z0-9])*)/.exec(pattern)?.[1] ?? ""
  const rest = pattern.slice(pattern.indexOf(prefix) + prefix.length)
  const text = prefix.replace(/\\(.)/g, "$1")
  return /^[*?{]/.test(rest) ? text.slice(0, -1) : text
}

function patternBindings(pattern: AstNode) {
  if (pattern.type !== "ArrayPattern" && pattern.type !== "ObjectPattern") return
  const bindings =
    pattern.type === "ArrayPattern"
      ? (Array.isArray(pattern.elements) ? pattern.elements : []).map((element, index) => {
          if (element === null) return { name: "", access: "", text: "" }
          const name = identifier(element)
          return name === undefined ? undefined : { name, access: "[" + index + "]", text: name }
        })
      : (Array.isArray(pattern.properties) ? pattern.properties : []).map((value) => {
          const property = asNode(value)
          if (property?.type !== "Property" || property.computed === true) return
          const key = identifier(property.key)
          const name = identifier(property.value)
          if (key === undefined || name === undefined) return
          return { name, access: "." + key, text: key === name ? name : key + ": " + name }
        })
  if (bindings.length === 0 || bindings.some((binding) => binding === undefined)) return
  return bindings.filter((binding) => binding !== undefined)
}

/** Short source text for simple expressions, so a rewrite can reuse the model's own names. */
function source(value: unknown): string | undefined {
  const node = asNode(value)
  if (node === undefined) return
  if (node.type === "Identifier") return identifier(node)
  if (node.type === "Literal" && (typeof node.value === "string" || typeof node.value === "number"))
    return JSON.stringify(node.value)
  if (node.type === "MemberExpression") {
    const object = source(node.object)
    const property = asNode(node.property)
    if (object === undefined || property === undefined) return
    if (node.computed !== true)
      return identifier(property) && object + (node.optional ? "?." : ".") + identifier(property)
    const key = source(property)
    return key && object + "[" + key + "]"
  }
  if (node.type === "CallExpression") {
    const callee = source(node.callee)
    return callee && callee + (Array.isArray(node.arguments) && node.arguments.length > 0 ? "(...)" : "()")
  }
}

function identifier(value: unknown): string | undefined {
  const node = asNode(value)
  return node?.type === "Identifier" && typeof node.name === "string" ? node.name : undefined
}

function isRegex(node: AstNode) {
  return node.type === "Literal" && isRecord(node.regex)
}

function asNode(value: unknown): AstNode | undefined {
  return isRecord(value) && typeof value.type === "string" ? (value as AstNode) : undefined
}
