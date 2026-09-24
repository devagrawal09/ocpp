/**
 * Names every activation already binds in its global scope. This module is plain data so the
 * compiler and the runtime can share it: the runtime builds its global scope from these lists, and
 * the compiler rejects durable notebook names that would shadow them. Keeping one list means a new
 * global cannot silently become shadowable by a saved value.
 */

export const globalNamespaces = ["Object", "Math", "JSON", "Array", "console", "time", "url"] as const

export const coercionFunctions = ["Number", "String", "Boolean", "parseInt", "parseFloat", "isFinite", "isNaN"] as const

export const uriFunctions = ["encodeURI", "encodeURIComponent", "decodeURI", "decodeURIComponent"] as const

export const errorConstructorNames = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
] as const

/** Globals with their own runtime representation: tool access, discovery, and language constants. */
export const intrinsicGlobals = ["tools", "tool", "input", "Symbol", "undefined", "NaN", "Infinity"] as const

/**
 * A durable notebook name may never be one of these. A notebook name is permanent, so a declaration
 * that shadowed a builtin would hide it from every later execution in the Session forever.
 */
export const reservedNames: ReadonlySet<string> = new Set<string>([
  ...globalNamespaces,
  ...coercionFunctions,
  ...uriFunctions,
  ...errorConstructorNames,
  ...intrinsicGlobals,
])
