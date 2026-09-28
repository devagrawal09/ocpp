import { ToolHandle } from "../tool-handle.js"
import { ToolReference } from "../tool-runtime.js"
import { IR_VERSION } from "../ir.js"
import {
  BrokenNotebookValue,
  brokenNotebookSuggestions,
  CodeModeFunction,
  InterpreterRuntimeError,
  isRecord,
  type AstNode,
  type Binding,
} from "./model.js"

/** Reserved key that distinguishes encoded durable functions from plain records. */
export const DURABLE_MARKER = "$codemode"

/**
 * A value that survives execution, restart, fork, and revert: JSON data plus durable functions whose
 * compiled body, exact captures, and static tool paths are stored with them.
 */
export type NotebookValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<NotebookValue>
  | { readonly [key: string]: NotebookValue }

type StoredFunction = {
  readonly [DURABLE_MARKER]: "function"
  readonly version: number
  readonly source: string
  readonly node: AstNode
  readonly captures: Readonly<Record<string, NotebookValue>>
}

type StoredReference = {
  readonly [DURABLE_MARKER]: "reference"
  readonly name: string
}

export type DurableLimits = {
  /** Maximum nesting depth of one durable value. */
  readonly maxDepth: number
  /** Maximum encoded UTF-8 bytes of one durable value. */
  readonly maxBytes: number | undefined
}

export const defaultDurableLimits: DurableLimits = { maxDepth: 32, maxBytes: undefined }

const invalid = (message: string, suggestions?: ReadonlyArray<string>) =>
  new InterpreterRuntimeError(message, undefined, "InvalidDurableValue", suggestions)

// Source positions describe the program that defined the function, not the one that later invokes
// it, so a saved body keeps only the syntax and reports diagnostics without a misleading location.
const withoutPositions = (node: AstNode): AstNode =>
  Object.fromEntries(
    Object.entries(node).flatMap(([key, value]) => {
      if (key === "loc" || key === "start" || key === "end" || key === "range") return []
      if (Array.isArray(value))
        return [[key, value.map((item) => (isRecord(item) ? withoutPositions(item as AstNode) : item))] as const]
      return [[key, isRecord(value) ? withoutPositions(value as AstNode) : value] as const]
    }),
  ) as AstNode

const storedKind = (value: unknown): "function" | "reference" | undefined => {
  if (!isRecord(value)) return undefined
  const marker = (value as Record<string, unknown>)[DURABLE_MARKER]
  return marker === "function" || marker === "reference" ? marker : undefined
}

/** Whether a saved notebook value is a durable function, including a reference to another saved function. */
export const isFunctionValue = (value: NotebookValue) => storedKind(value) !== undefined

/**
 * Encodes the values a successful program declares at the top level. A function already bound to a
 * notebook name is stored as a reference to that immutable name, so recursive and mutually recursive
 * declarations stay finite; every other value is copied exactly.
 */
export const encodeDeclarations = (
  declarations: ReadonlyArray<readonly [string, unknown]>,
  notebook: ReadonlyMap<string, unknown>,
  limits: DurableLimits = defaultDurableLimits,
): Record<string, NotebookValue> => {
  const named = new Map<unknown, string>()
  for (const [name, value] of notebook)
    if (value instanceof CodeModeFunction && !named.has(value)) named.set(value, name)
  for (const [name, value] of declarations)
    if (value instanceof CodeModeFunction && !named.has(value)) named.set(value, name)

  const encode = (value: unknown, label: string, depth: number, selfName?: string): NotebookValue => {
    if (depth > limits.maxDepth)
      throw invalid(`${label} exceeds the maximum durable value depth of ${limits.maxDepth}.`)
    if (value === null || value === undefined) return null
    if (typeof value === "boolean" || typeof value === "string") return value
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw invalid(`${label} contains ${String(value)}, which is not durable data.`)
      // JSON has no negative zero, so normalize it here rather than letting a fresh in-memory
      // binding and its persisted round trip disagree.
      return value === 0 ? 0 : value
    }
    if (value instanceof ToolHandle)
      throw invalid(`${label} contains a live tool handle, which exists only for one execution.`, [
        "Publish the data a handle produces, or define the handle again in the execution that uses it.",
      ])
    if (value instanceof ToolReference)
      throw invalid(`${label} contains a tool reference, which exists only for one execution.`, [
        "Write the reference, such as tools.fs.read, in the execution that passes it to a tool.",
      ])
    // A capture can hold a quarantined binding without the program ever reading the name.
    if (value instanceof BrokenNotebookValue)
      throw invalid(`${label} depends on a stored value that cannot be loaded. ${value.message}`, [
        ...brokenNotebookSuggestions,
      ])
    if (value instanceof CodeModeFunction) {
      const name = named.get(value)
      if (name !== undefined && name !== selfName)
        return { [DURABLE_MARKER]: "reference", name } satisfies StoredReference as NotebookValue
      return encodeFunction(value, label, depth)
    }
    if (typeof value !== "object") throw invalid(`${label} contains ${typeof value}, which is not durable data.`)
    // Array.from visits holes, which JSON also writes as null, so a sparse array cannot survive
    // in memory as a hole and come back from storage as null.
    if (Array.isArray(value))
      return Array.from(value, (item, index) => encode(item, `${label}[${index}]`, depth + 1)) as NotebookValue
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) throw invalid(`${label} must contain plain records only.`)
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        if (key === DURABLE_MARKER) throw invalid(`${label} contains the reserved key '${DURABLE_MARKER}'.`)
        return item === undefined ? [] : [[key, encode(item, `${label}.${key}`, depth + 1)] as const]
      }),
    )
  }

  const encodeFunction = (value: CodeModeFunction, label: string, depth: number): NotebookValue => {
    if (value.unresolved.length > 0)
      throw invalid(`${label} reads unknown identifier '${value.unresolved[0]}'.`, [
        "A durable function may read only its parameters, its own locals, host globals, and values that exist when it is saved.",
      ])
    return {
      [DURABLE_MARKER]: "function",
      version: IR_VERSION,
      source: value.source,
      node: withoutPositions(value.node),
      captures: Object.fromEntries(
        [...value.captures].map(([name, binding]) => [
          name,
          encode(binding.value, `${label} capture '${name}'`, depth + 1),
        ]),
      ),
    } satisfies StoredFunction as unknown as NotebookValue
  }

  return Object.fromEntries(
    declarations.map(([name, value]) => {
      const encoded = encode(value, `Notebook value '${name}'`, 0, name)
      if (limits.maxBytes !== undefined) {
        const bytes = new TextEncoder().encode(JSON.stringify(encoded) ?? "null").byteLength
        if (bytes > limits.maxBytes)
          throw invalid(
            `Notebook value '${name}' is ${bytes} bytes and exceeds the ${limits.maxBytes}-byte durable value limit.`,
            ["Publish a smaller summary, or keep large artifacts in files through host tools."],
          )
      }
      return [name, encoded]
    }),
  )
}

/**
 * Rebuilds a stored notebook. Functions become fresh activation-local closures over their exact
 * saved captures; their tool paths resolve and re-authorize against the current host catalog.
 *
 * One damaged stored value never fails the activation. It is quarantined in its own binding, and so
 * is every binding that references it, so unrelated later code still runs and only a program that
 * reads the name receives the diagnostic.
 */
export const decodeNotebook = (
  bindings: Readonly<Record<string, NotebookValue>>,
  makeFunction: (stored: { node: AstNode; source: string }, captures: Map<string, Binding>) => CodeModeFunction,
): Map<string, Binding> => {
  const scope = new Map<string, Binding>()
  const state = new Map<string, "pending" | "resolving" | "resolved" | "broken">()
  for (const name of Object.keys(bindings)) {
    scope.set(name, { mutable: false, value: undefined, initialized: true })
    state.set(name, "pending")
  }

  const binding = (name: string, label: string): Binding => {
    const found = scope.get(name)
    if (!found) throw invalid(`${label} references missing notebook value '${name}'.`)
    return found
  }

  const decode = (value: NotebookValue, label: string): unknown => {
    if (value === null || typeof value !== "object") return value
    if (Array.isArray(value)) return value.map((item, index) => decode(item, `${label}[${index}]`))
    const kind = storedKind(value)
    if (kind === "reference") return resolve((value as unknown as StoredReference).name, label)
    if (kind === "function") {
      const stored = value as unknown as StoredFunction
      if (stored.version !== IR_VERSION)
        throw invalid(
          `${label} was compiled for IR version ${stored.version}; this host runs version ${IR_VERSION}. Declare it again.`,
        )
      const captures = new Map<string, Binding>()
      const fn = makeFunction({ node: stored.node, source: stored.source }, captures)
      for (const [name, capture] of Object.entries(stored.captures)) {
        const label_ = `${label} capture '${name}'`
        // A referenced capture shares the notebook binding, so recursive saved functions rebuild
        // without resolving themselves while they are still being built.
        if (storedKind(capture) === "reference")
          captures.set(name, binding((capture as unknown as StoredReference).name, label_))
        else captures.set(name, { mutable: false, value: decode(capture, label_), initialized: true })
      }
      return fn
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, NotebookValue>).map(([key, item]) => [
        key,
        decode(item, `${label}.${key}`),
      ]),
    )
  }

  const resolve = (name: string, label: string): unknown => {
    const target = binding(name, label)
    if (state.get(name) === "resolved") return target.value
    if (target.value instanceof BrokenNotebookValue) throw invalid(target.value.message)
    if (state.get(name) === "resolving") throw invalid(`Notebook value '${name}' contains itself.`)
    state.set(name, "resolving")
    try {
      target.value = decode(bindings[name] as NotebookValue, `Notebook value '${name}'`)
    } catch (error) {
      state.set(name, "broken")
      const broken = new BrokenNotebookValue(name, error instanceof Error ? error.message : String(error))
      target.value = broken
      throw invalid(broken.message)
    }
    state.set(name, "resolved")
    return target.value
  }

  for (const name of Object.keys(bindings)) {
    if (state.get(name) !== "pending") continue
    // Quarantine is recorded by resolve itself, so a failure here only stops this one name.
    try {
      resolve(name, `Notebook value '${name}'`)
    } catch {
      continue
    }
  }
  return scope
}
