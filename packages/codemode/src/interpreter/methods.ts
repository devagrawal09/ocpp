import { Effect } from "effect"
import {
  type AstNode,
  CodeModeFunction,
  CodeModeGenerator,
  CoercionFunction,
  ErrorConstructorReference,
  GlobalMethodReference,
  GlobalNamespace,
  IntrinsicReference,
  InterpreterRuntimeError,
  JsonMethodReference,
  PromiseCapabilityFunction,
  PromiseNamespace,
  UriFunction,
} from "./model.js"
import { containsOpaqueReference, isRuntimeReference, rejectCircularInsertion, typeofValue } from "./references.js"
import { collectionLimitMessage, MAX_COLLECTION_ITEMS, MAX_STRING_LENGTH, stringLimitMessage } from "../limits.js"
import { isBlockedMember, type SafeObject } from "../tool-runtime.js"
import { CodeModePromise } from "../values.js"
import { invokeMathMethod } from "../stdlib/math.js"
import { invokeNumberMethod, invokeNumberStatic } from "../stdlib/number.js"
import { invokeObjectMethod } from "../stdlib/object.js"
import { invokeStringStatic } from "../stdlib/string.js"
import { invokeTimeMethod } from "../stdlib/time.js"
import { invokeUrlMethod } from "../stdlib/url.js"
import { boundedData, coerceToNumber, coerceToString, errorBrandName } from "../stdlib/value.js"
import { preserveConsumerError, type SyncIteratorRunner } from "./iterator.js"

export type CallbackRunner<R> = {
  readonly invokeFunction: (fn: CodeModeFunction, args: Array<unknown>) => Effect.Effect<unknown, unknown, R>
  readonly invokeCallable: (
    callable: unknown,
    args: Array<unknown>,
    node: AstNode,
  ) => Effect.Effect<unknown, unknown, R>
  readonly settlePromise: (promise: CodeModePromise) => Effect.Effect<unknown, unknown, never>
}

// The single acceptance list for callbacks: collections, sort, string replacers,
// Array.from mappers, and promise reactions all admit exactly these callables.
// Admission means dispatchable, not necessarily invocable: new-requiring
// constructors pass the gate and throw a TypeError on call, like JS.
export type SupportedCallback =
  | CodeModeFunction
  | CoercionFunction
  | UriFunction
  | PromiseCapabilityFunction
  | GlobalMethodReference
  | JsonMethodReference
  | IntrinsicReference
  | ErrorConstructorReference
  | GlobalNamespace
  | PromiseNamespace

export const isSupportedCallback = (value: unknown): value is SupportedCallback =>
  value instanceof CodeModeFunction ||
  value instanceof CoercionFunction ||
  value instanceof UriFunction ||
  value instanceof PromiseCapabilityFunction ||
  value instanceof GlobalMethodReference ||
  value instanceof JsonMethodReference ||
  value instanceof IntrinsicReference ||
  value instanceof ErrorConstructorReference ||
  // Callable namespaces dispatch like JS: Array and Object construct,
  // new-requiring constructors throw a TypeError. Math/JSON/console stay non-callable.
  (value instanceof GlobalNamespace && typeofValue(value) === "function") ||
  value instanceof PromiseNamespace

export const invokeIntrinsic = <R>(
  runner: CallbackRunner<R>,
  ref: IntrinsicReference,
  args: Array<unknown>,
  node: AstNode,
): Effect.Effect<unknown, unknown, R> => {
  if (typeof ref.receiver === "string") {
    if (ref.name === "replace" || ref.name === "replaceAll") {
      if (isSupportedCallback(args[1])) return invokeStringReplacer(runner, ref.receiver, ref.name, args, node)
      if (typeofValue(args[1]) === "function") {
        throw new InterpreterRuntimeError(
          `String.${ref.name} cannot use this callable as a replacer; wrap it in an arrow function, e.g. (match) => tools.ns.tool(match).`,
          node,
        )
      }
    }
    return Effect.succeed(invokeStringMethod(ref.receiver, ref.name, args, node))
  }
  if (typeof ref.receiver === "number") {
    return Effect.succeed(invokeNumberMethod(ref.receiver, ref.name, args, node))
  }
  if (Array.isArray(ref.receiver)) {
    return invokeArrayMethod(runner, ref.receiver, ref.name, args, node)
  }
  throw new InterpreterRuntimeError(`Method '${ref.name}' is not available.`, node)
}

export const invokeGlobalMethod = (ref: GlobalMethodReference, args: Array<unknown>, node: AstNode): unknown => {
  if (ref.namespace === "console") throw new InterpreterRuntimeError(`console.${ref.name} is not available.`, node)
  if (ref.namespace === "Object") return invokeObjectMethod(ref.name, args, node)
  if (ref.namespace === "Math") return invokeMathMethod(ref.name, args, node)
  if (ref.namespace === "Array") return invokeArrayStatic(ref.name, args, node)
  if (ref.namespace === "Number") return invokeNumberStatic(ref.name, args, node)
  if (ref.namespace === "String") return invokeStringStatic(ref.name, args, node)
  if (ref.namespace === "time") return invokeTimeMethod(ref.name, args, node)
  if (ref.namespace === "url") return invokeUrlMethod(ref.name, args, node)
  throw new InterpreterRuntimeError(`${ref.namespace}.${ref.name} is not available.`, node)
}

const requireDataArgument = (name: string, index: number, arg: unknown, node: AstNode): unknown => {
  if (containsOpaqueReference(arg)) {
    throw new InterpreterRuntimeError(
      `String.${name} expects argument ${index + 1} to be a data value.`,
      node,
      "InvalidDataValue",
    )
  }
  return arg
}

const invokeStringMethod = (value: string, name: string, args: Array<unknown>, node: AstNode): unknown => {
  // Coerce arguments like native JS; opaque runtime references still reject.
  const str = (index: number): string => coerceToString(requireDataArgument(name, index, args[index], node))
  const num = (index: number): number => coerceToNumber(requireDataArgument(name, index, args[index], node))
  const optNum = (index: number): number | undefined => (args[index] === undefined ? undefined : num(index))
  const optStr = (index: number): string | undefined => (args[index] === undefined ? undefined : str(index))
  // These operations build their whole result inside one native call, so a length the arguments
  // already imply is checked before that call rather than after it.
  const withinStringLimit = (characters: number): void => {
    if (characters > MAX_STRING_LENGTH) {
      throw new InterpreterRuntimeError(
        stringLimitMessage(`String.${name} result`, characters),
        node,
        "InvalidDataValue",
      ).as("RangeError")
    }
  }
  let result: unknown
  switch (name) {
    case "toLowerCase":
      result = value.toLowerCase()
      break
    case "toUpperCase":
      result = value.toUpperCase()
      break
    case "trim":
      result = value.trim()
      break
    case "trimStart":
      result = value.trimStart()
      break
    case "trimEnd":
      result = value.trimEnd()
      break
    // Locale/options are deliberately unsupported; comparison uses the host default locale.
    case "localeCompare":
      result = value.localeCompare(str(0))
      break
    case "normalize": {
      const form = optStr(0)
      try {
        result = value.normalize(form)
      } catch {
        throw new InterpreterRuntimeError(
          `String.normalize expects the form "NFC", "NFD", "NFKC", or "NFKD" (got ${JSON.stringify(form)}).`,
          node,
        ).as("RangeError")
      }
      break
    }
    case "split": {
      // Native: an undefined separator returns the whole string, not a split on "undefined",
      // unless the limit truncates to zero.
      if (args[0] === undefined) {
        const requestedLimit = optNum(1)
        result = requestedLimit !== undefined && requestedLimit >>> 0 === 0 ? [] : [value]
        break
      }
      const requestedLimit = optNum(1)
      // Splitting one bounded string can ask for one piece per character, so the native limit stops
      // the scan one piece past the ceiling instead of materializing them all and rejecting after.
      const pieces = value.split(
        str(0),
        Math.min(
          requestedLimit === undefined ? MAX_COLLECTION_ITEMS + 1 : requestedLimit >>> 0,
          MAX_COLLECTION_ITEMS + 1,
        ),
      )
      if (pieces.length > MAX_COLLECTION_ITEMS) {
        throw new InterpreterRuntimeError(
          collectionLimitMessage("String.split result", pieces.length),
          node,
          "InvalidDataValue",
        ).as("RangeError")
      }
      result = pieces
      break
    }
    case "slice":
      result = value.slice(optNum(0), optNum(1))
      break
    case "includes":
      result = value.includes(str(0), optNum(1))
      break
    case "startsWith":
      result = value.startsWith(str(0), optNum(1))
      break
    case "endsWith":
      result = value.endsWith(str(0), optNum(1))
      break
    case "indexOf":
      result = value.indexOf(str(0), optNum(1))
      break
    case "lastIndexOf":
      result = value.lastIndexOf(str(0), optNum(1))
      break
    case "replace":
    case "replaceAll": {
      const search = str(0)
      const replacement = str(1)
      if (name === "replace") {
        withinStringLimit(value.length - search.length + replacement.length)
        result = value.replace(search, replacement)
        break
      }
      // Every occurrence grows by the same difference, and the occurrence count cannot exceed one
      // per separator length, so the largest possible result is known without scanning.
      const occurrences = search.length === 0 ? value.length + 1 : Math.floor(value.length / search.length)
      withinStringLimit(value.length + occurrences * Math.max(0, replacement.length - search.length))
      result = value.replaceAll(search, replacement)
      break
    }
    case "repeat": {
      const count = num(0)
      if (!Number.isFinite(count) || count < 0)
        throw new InterpreterRuntimeError("String.repeat expects a finite non-negative count.", node).as("RangeError")
      withinStringLimit(count * value.length)
      result = value.repeat(count)
      break
    }
    case "padStart": {
      const target = num(0)
      withinStringLimit(target)
      result = value.padStart(target, optStr(1))
      break
    }
    case "padEnd": {
      const target = num(0)
      withinStringLimit(target)
      result = value.padEnd(target, optStr(1))
      break
    }
    case "charAt":
      result = value.charAt(optNum(0) ?? 0)
      break
    case "at":
      result = value.at(optNum(0) ?? 0)
      break
    case "substring":
      result = value.substring(optNum(0) ?? 0, optNum(1))
      break
    case "charCodeAt":
      result = value.charCodeAt(optNum(0) ?? 0)
      break
    case "codePointAt":
      result = value.codePointAt(optNum(0) ?? 0)
      break
    case "toString":
      result = value
      break
    case "concat": {
      const parts = args.map((_, index) => str(index))
      withinStringLimit(parts.reduce((total, part) => total + part.length, value.length))
      result = value.concat(...parts)
      break
    }
    default:
      throw new InterpreterRuntimeError(`String method '${name}' is not available.`, node)
  }
  return boundedData(result, `String.${name} result`)
}

export const arrayStatics = new Set(["isArray", "of", "from"])

const invokeArrayStatic = (name: string, args: Array<unknown>, node: AstNode): unknown => {
  switch (name) {
    case "isArray":
      return Array.isArray(args[0])
    case "of":
      return [...args]
    default:
      throw new InterpreterRuntimeError(`Array.${name} is not available.`, node)
  }
}

const arrayLikeSource = (source: unknown, node: AstNode): { readonly length: number; readonly source: object } => {
  if (source instanceof CodeModePromise) {
    throw new InterpreterRuntimeError(
      "Array.from received an un-awaited Promise; await it before creating the array.",
      node,
      "InvalidDataValue",
    )
  }
  if (
    source !== null &&
    typeof source === "object" &&
    (Object.getPrototypeOf(source) === Object.prototype || Object.getPrototypeOf(source) === null) &&
    typeof (source as { length?: unknown }).length === "number"
  ) {
    const length = (source as { length: number }).length
    const normalized = Number.isNaN(length) || length <= 0 ? 0 : Math.trunc(length)
    if (normalized > 4_294_967_295) throw new RangeError("Invalid array length")
    // `{ length: 4e9 }` costs the program nothing and would cost the host a densified array of that
    // size, so the request is refused before the read loop starts.
    if (normalized > MAX_COLLECTION_ITEMS) {
      throw new InterpreterRuntimeError(
        collectionLimitMessage("Array.from result", normalized),
        node,
        "InvalidDataValue",
      ).as("RangeError")
    }
    return { length: normalized, source }
  }
  throw new InterpreterRuntimeError(
    "Array.from expects an array, string, or array-like value.",
    node,
    "InvalidDataValue",
  )
}

export const invokeArrayFrom = <R>(
  runner: CallbackRunner<R> & SyncIteratorRunner<R>,
  args: Array<unknown>,
  node: AstNode,
): Effect.Effect<unknown, unknown, R> => {
  const source = args[0]
  const apply =
    args.length < 2 || args[1] === undefined ? undefined : applyCollectionCallback(runner, args[1], "Array.from", node)
  return Effect.gen(function* () {
    const cursor = yield* runner.syncIterator(source, node)
    if (cursor === undefined) {
      if (source instanceof CodeModeGenerator) {
        throw new InterpreterRuntimeError("Array.from expects a synchronous iterable or array-like value.", node).as(
          "TypeError",
        )
      }
      const arrayLike = arrayLikeSource(source, node)
      const values: Array<unknown> = []
      for (let index = 0; index < arrayLike.length; index += 1) {
        const item = Reflect.get(arrayLike.source, index)
        values.push(apply === undefined ? item : yield* apply([item, index]))
      }
      return values
    }
    const values: Array<unknown> = []
    let index = 0
    while (true) {
      const step = yield* cursor.next
      if (step.done) return values
      values.push(apply === undefined ? step.value : yield* preserveConsumerError(cursor, apply([step.value, index])))
      if (values.length > MAX_COLLECTION_ITEMS) {
        throw new InterpreterRuntimeError(
          collectionLimitMessage("Array.from result", values.length),
          node,
          "InvalidDataValue",
        ).as("RangeError")
      }
      index += 1
    }
  })
}

export const invokeGroupBy = <R>(
  runner: CallbackRunner<R> & SyncIteratorRunner<R>,
  args: Array<unknown>,
  node: AstNode,
): Effect.Effect<unknown, unknown, R> => {
  const source = args[0]
  if (source === null || source === undefined) {
    throw new InterpreterRuntimeError("Object.groupBy expects an iterable collection.", node).as("TypeError")
  }
  const apply = applyCollectionCallback(runner, args[1], "Object.groupBy", node)
  return Effect.gen(function* () {
    const cursor = yield* runner.syncIterator(source, node)
    if (cursor === undefined) {
      throw new InterpreterRuntimeError("Object.groupBy expects an iterable collection.", node).as("TypeError")
    }
    const result: SafeObject = Object.create(null) as SafeObject
    let index = 0
    while (true) {
      const step = yield* cursor.next
      if (step.done) return result
      const item = step.value
      const key = yield* preserveConsumerError(
        cursor,
        Effect.flatMap(apply([item, index]), (value) => coerceGroupByPropertyKey(runner, value, node)),
      )
      if (isBlockedMember(key)) {
        return yield* preserveConsumerError(
          cursor,
          Effect.fail(new InterpreterRuntimeError(`Property '${key}' is not available.`, node)),
        )
      }
      const group = result[key]
      if (group === undefined) result[key] = [item]
      else (group as Array<unknown>).push(item)
      index += 1
    }
  })
}

const coerceGroupByPropertyKey = <R>(
  runner: CallbackRunner<R>,
  value: unknown,
  node: AstNode,
): Effect.Effect<string, unknown, R> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return Effect.succeed(coerceToString(value))
  }
  if (value instanceof CodeModePromise) return Effect.succeed("[object Promise]")
  if (isRuntimeReference(value)) {
    throw new InterpreterRuntimeError("Object.groupBy callback must return a data value.", node, "InvalidDataValue")
  }
  const object = value as Record<string, unknown>
  if (!Object.hasOwn(object, "toString")) return Effect.succeed(coerceToString(value))
  return Effect.gen(function* () {
    if (typeofValue(object.toString) === "function") {
      const result = yield* runner.invokeCallable(object.toString, [], node)
      if (result === null || (typeof result !== "object" && typeof result !== "function")) {
        return coerceToString(result)
      }
    }
    if (Object.hasOwn(object, "valueOf") && typeofValue(object.valueOf) === "function") {
      const result = yield* runner.invokeCallable(object.valueOf, [], node)
      if (result === null || (typeof result !== "object" && typeof result !== "function")) {
        return coerceToString(result)
      }
    }
    throw new InterpreterRuntimeError("Cannot convert object to primitive value.", node).as("TypeError")
  })
}

const invokeStringReplacer = <R>(
  runner: CallbackRunner<R>,
  value: string,
  name: "replace" | "replaceAll",
  args: Array<unknown>,
  node: AstNode,
): Effect.Effect<unknown, unknown, R> => {
  const apply = applyCollectionCallback(runner, args[1], `String.${name}`, node)
  const matches: Array<{ readonly match: string; readonly offset: number; readonly args: Array<unknown> }> = []
  const collect = (...callbackArgs: Array<unknown>): string => {
    const match = callbackArgs[0]
    const groups = callbackArgs[callbackArgs.length - 1]
    const hasGroups = groups !== null && typeof groups === "object"
    const offset = callbackArgs[callbackArgs.length - (hasGroups ? 3 : 2)]
    if (typeof match !== "string" || typeof offset !== "number") {
      throw new InterpreterRuntimeError(`String.${name} produced an invalid replacement match.`, node)
    }
    if (hasGroups) {
      const safeGroups: SafeObject = Object.create(null) as SafeObject
      for (const [key, group] of Object.entries(groups)) {
        if (!isBlockedMember(key)) safeGroups[key] = group
      }
      callbackArgs[callbackArgs.length - 1] = safeGroups
    }
    matches.push({ match, offset, args: callbackArgs })
    return match
  }

  const search = coerceToString(requireDataArgument(name, 0, args[0], node))
  if (name === "replace") value.replace(search, collect)
  else value.replaceAll(search, collect)

  return Effect.gen(function* () {
    const output: Array<string> = []
    let end = 0
    let characters = 0
    for (const match of matches) {
      const replacement = yield* apply(match.args)
      // Error values are branded plain objects; boundedData would strip the brand before coercion.
      const replaced =
        replacement instanceof CodeModePromise
          ? "[object Promise]"
          : errorBrandName(replacement)
            ? coerceToString(replacement)
            : coerceToString(boundedData(replacement, `String.${name} replacer result`))
      output.push(value.slice(end, match.offset), replaced)
      // A replacer returns a whole string per match, so the result is measured as it accumulates
      // rather than after the join has already built it.
      characters += match.offset - end + replaced.length
      if (characters > MAX_STRING_LENGTH) {
        throw new InterpreterRuntimeError(
          stringLimitMessage(`String.${name} result`, characters),
          node,
          "InvalidDataValue",
        ).as("RangeError")
      }
      end = match.offset + match.match.length
    }
    output.push(value.slice(end))
    return boundedData(output.join(""), `String.${name} result`)
  })
}

export const applyCollectionCallback = <R>(
  runner: CallbackRunner<R>,
  callback: unknown,
  name: string,
  node: AstNode,
): ((args: Array<unknown>) => Effect.Effect<unknown, unknown, R>) => {
  if (!isSupportedCallback(callback)) {
    if (typeofValue(callback) === "function") {
      throw new InterpreterRuntimeError(
        `${name} cannot use this callable as a callback; wrap it in an arrow function, e.g. (value) => tools.ns.tool(value).`,
        node,
      )
    }
    throw new InterpreterRuntimeError(`${name} expects a function callback.`, node).as("TypeError")
  }
  return (callbackArgs) => runner.invokeCallable(callback, callbackArgs, node)
}

const invokeArrayMethod = <R>(
  runner: CallbackRunner<R>,
  target: Array<unknown>,
  name: string,
  args: Array<unknown>,
  node: AstNode,
): Effect.Effect<unknown, unknown, R> => {
  const optNumber = (value: unknown, label: string): number | undefined => {
    if (value === undefined) return undefined
    if (typeof value !== "number")
      throw new InterpreterRuntimeError(`Array.${name} expects ${label} to be a number.`, node)
    return value
  }
  // Growing methods know their result length from their arguments, so they check it before the
  // native call. Every other method may then rely on an array already holding at most the limit.
  const withinCollectionLimit = (items: number): void => {
    if (items > MAX_COLLECTION_ITEMS) {
      throw new InterpreterRuntimeError(
        collectionLimitMessage(`Array.${name} result`, items),
        node,
        "InvalidDataValue",
      ).as("RangeError")
    }
  }
  switch (name) {
    case "join": {
      if (args.length > 1 || (args.length === 1 && typeof args[0] !== "string")) {
        throw new InterpreterRuntimeError("Array.join expects zero arguments or one string separator.", node)
      }
      const separator = args.length === 0 ? "," : (args[0] as string)
      const parts = (boundedData(target, "Array.join input") as Array<unknown>).map((item) =>
        coerceToString(item ?? ""),
      )
      // A long separator between many items is an amplifier, so the exact result length is summed
      // from the parts before the native join builds it.
      const joined =
        parts.reduce((total, part) => total + part.length, 0) + Math.max(0, parts.length - 1) * separator.length
      if (joined > MAX_STRING_LENGTH) {
        throw new InterpreterRuntimeError(stringLimitMessage("Array.join result", joined), node, "InvalidDataValue").as(
          "RangeError",
        )
      }
      return Effect.succeed(parts.join(separator))
    }
    case "includes":
      if (args.length === 0 || args.length > 2)
        throw new InterpreterRuntimeError("Array.includes expects a value and optional start index.", node)
      return Effect.succeed(target.includes(args[0], optNumber(args[1], "start index")))
    case "indexOf":
      return Effect.succeed(target.indexOf(args[0], optNumber(args[1], "start index")))
    case "lastIndexOf":
      return Effect.succeed(
        args[1] === undefined
          ? target.lastIndexOf(args[0])
          : target.lastIndexOf(args[0], optNumber(args[1], "start index")),
      )
    case "at":
      return Effect.succeed(target.at(optNumber(args[0], "index") ?? 0))
    case "slice":
      return Effect.succeed(target.slice(optNumber(args[0], "start"), optNumber(args[1], "end")))
    case "concat":
      withinCollectionLimit(
        args.reduce<number>((total, arg) => total + (Array.isArray(arg) ? arg.length : 1), target.length),
      )
      return Effect.succeed(target.concat(...args))
    case "flat": {
      const depth = optNumber(args[0], "depth") ?? 1
      // A short array of repeated references names far more items than it holds, so the flattened
      // count is measured first. Counting stops at the limit, so a rejected call stays cheap.
      let items = 0
      const measure = (level: Array<unknown>, remaining: number): void =>
        level.forEach((item) => {
          if (remaining > 0 && Array.isArray(item)) measure(item, remaining - 1)
          else items += 1
          withinCollectionLimit(items)
        })
      measure(target, depth)
      return Effect.succeed(target.flat(depth))
    }
    case "reverse":
      return Effect.succeed(target.reverse())
    case "sort": {
      const length = target.length
      const holeCount = Array.from({ length }, (_, index) => Object.hasOwn(target, index)).filter((own) => !own).length
      const itemCount = length - holeCount
      return Effect.map(sortArray(runner, target, args[0], "Array.sort", node), (sorted) => {
        sorted.slice(0, itemCount).forEach((item, index) => {
          target[index] = item
        })
        Array.from({ length: holeCount }, (_, index) => itemCount + index).forEach((index) => {
          Reflect.deleteProperty(target, index)
        })
        return target
      })
    }
    case "toSorted":
      return sortArray(runner, target, args[0], "Array.toSorted", node)
    case "toReversed":
      return Effect.succeed([...target].reverse())
    case "with": {
      const index = optNumber(args[0], "index") ?? 0
      const resolved = index < 0 ? target.length + index : index
      if (resolved < 0 || resolved >= target.length) {
        throw new InterpreterRuntimeError("Array.with index is out of range.", node)
      }
      const copied = [...target]
      copied[resolved] = args[1]
      return Effect.succeed(copied)
    }
    case "push": {
      // Validate all insertions before mutating to avoid partial cyclic updates.
      for (const item of args) rejectCircularInsertion(target, item, "Array.push result", node)
      target.push(...args)
      return Effect.succeed(target.length)
    }
    case "unshift": {
      for (const item of args) rejectCircularInsertion(target, item, "Array.unshift result", node)
      target.unshift(...args)
      return Effect.succeed(target.length)
    }
    case "pop":
      return Effect.succeed(target.pop())
    case "shift":
      return Effect.succeed(target.shift())
    case "splice": {
      if (args.length === 0) return Effect.succeed(target.splice(0, 0))
      const start = optNumber(args[0], "start") ?? 0
      if (args.length === 1) return Effect.succeed(target.splice(start))
      const deleteCount = optNumber(args[1], "delete count") ?? 0
      const inserted = args.slice(2)
      for (const item of inserted) rejectCircularInsertion(target, item, "Array.splice result", node)
      return Effect.succeed(target.splice(start, deleteCount, ...inserted))
    }
    case "toSpliced": {
      if (args.length === 0) return Effect.succeed([...target])
      const start = optNumber(args[0], "start") ?? 0
      if (args.length === 1) {
        const copied = [...target]
        copied.splice(start)
        return Effect.succeed(copied)
      }
      const deleteCount = optNumber(args[1], "delete count") ?? 0
      withinCollectionLimit(target.length + args.length - 2)
      const copied = [...target]
      copied.splice(start, deleteCount, ...args.slice(2))
      return Effect.succeed(copied)
    }
    case "fill": {
      rejectCircularInsertion(target, args[0], "Array.fill result", node)
      return Effect.succeed(target.fill(args[0], optNumber(args[1], "start"), optNumber(args[2], "end")))
    }
    case "copyWithin":
      return Effect.succeed(
        target.copyWithin(
          optNumber(args[0], "target index") ?? 0,
          optNumber(args[1], "start") ?? 0,
          optNumber(args[2], "end"),
        ),
      )
    case "keys":
      return Effect.succeed(Array.from(target.keys()))
    case "values":
      return Effect.succeed([...target])
    case "entries":
      return Effect.succeed(Array.from(target.entries(), ([index, item]): Array<unknown> => [index, item]))
  }

  const apply = applyCollectionCallback(runner, args[0], `Array.${name}`, node)
  return Effect.gen(function* () {
    // Fix iteration length while reading existing elements live.
    const length = target.length
    switch (name) {
      case "map": {
        const values: Array<unknown> = []
        values.length = length
        for (let index = 0; index < length; index += 1) {
          if (!(index in target)) continue
          values[index] = yield* apply([target[index], index, target])
        }
        return values
      }
      case "flatMap": {
        const values: Array<unknown> = []
        for (let index = 0; index < length; index += 1) {
          if (!(index in target)) continue
          const mapped = yield* apply([target[index], index, target])
          if (Array.isArray(mapped)) values.push(...mapped)
          else values.push(mapped)
          // One callback can return a whole array, so the total grows faster than the iteration.
          if (values.length > MAX_COLLECTION_ITEMS) {
            throw new InterpreterRuntimeError(
              collectionLimitMessage("Array.flatMap result", values.length),
              node,
              "InvalidDataValue",
            ).as("RangeError")
          }
        }
        return values
      }
      case "filter": {
        const values: Array<unknown> = []
        for (let index = 0; index < length; index += 1) {
          if (!(index in target)) continue
          const item = target[index]
          if (yield* apply([item, index, target])) values.push(item)
        }
        return values
      }
      case "find":
        for (let index = 0; index < length; index += 1) {
          const item = target[index]
          if (yield* apply([item, index, target])) return item
        }
        return undefined
      case "findIndex":
        for (let index = 0; index < length; index += 1) {
          if (yield* apply([target[index], index, target])) return index
        }
        return -1
      case "some":
        for (let index = 0; index < length; index += 1) {
          if (!(index in target)) continue
          if (yield* apply([target[index], index, target])) return true
        }
        return false
      case "every":
        for (let index = 0; index < length; index += 1) {
          if (!(index in target)) continue
          if (!(yield* apply([target[index], index, target]))) return false
        }
        return true
      case "forEach":
        for (let index = 0; index < length; index += 1) {
          if (index in target) yield* apply([target[index], index, target])
        }
        return undefined
      case "reduce": {
        let start = 0
        let accumulator = args[1]
        if (args.length < 2) {
          while (start < length && !(start in target)) start += 1
          if (start === length)
            throw new InterpreterRuntimeError("Array.reduce of an empty array with no initial value.", node).as(
              "TypeError",
            )
          accumulator = target[start]
          start += 1
        }
        for (let index = start; index < length; index += 1) {
          if (!(index in target)) continue
          accumulator = yield* apply([accumulator, target[index], index, target])
        }
        return accumulator
      }
      case "reduceRight": {
        let start = length - 1
        let accumulator = args[1]
        if (args.length < 2) {
          while (start >= 0 && !(start in target)) start -= 1
          if (start < 0)
            throw new InterpreterRuntimeError("Array.reduceRight of an empty array with no initial value.", node).as(
              "TypeError",
            )
          accumulator = target[start]
          start -= 1
        }
        for (let index = start; index >= 0; index -= 1) {
          if (!(index in target)) continue
          accumulator = yield* apply([accumulator, target[index], index, target])
        }
        return accumulator
      }
      case "findLast":
        for (let index = length - 1; index >= 0; index -= 1) {
          const item = target[index]
          if (yield* apply([item, index, target])) return item
        }
        return undefined
      case "findLastIndex":
        for (let index = length - 1; index >= 0; index -= 1) {
          if (yield* apply([target[index], index, target])) return index
        }
        return -1
    }
    throw new InterpreterRuntimeError(`Array method '${name}' is not available.`, node)
  })
}

const sortArray = <R>(
  runner: CallbackRunner<R>,
  target: Array<unknown>,
  comparator: unknown,
  name: string,
  node: AstNode,
): Effect.Effect<Array<unknown>, unknown, R> => {
  if (comparator === undefined) {
    return Effect.sync(() =>
      [...target].sort((a, b) => {
        const left = coerceToString(a)
        const right = coerceToString(b)
        return left < right ? -1 : left > right ? 1 : 0
      }),
    )
  }
  const apply = applyCollectionCallback(runner, comparator, name, node)
  const mergeSort = (items: Array<unknown>): Effect.Effect<Array<unknown>, unknown, R> => {
    if (items.length <= 1) return Effect.succeed(items)
    const midpoint = Math.floor(items.length / 2)
    return Effect.gen(function* () {
      const left = yield* mergeSort(items.slice(0, midpoint))
      const right = yield* mergeSort(items.slice(midpoint))
      const merged: Array<unknown> = []
      let leftIndex = 0
      let rightIndex = 0
      while (leftIndex < left.length && rightIndex < right.length) {
        // Treat a NaN comparator result as equal to preserve stable ordering.
        const order = coerceToNumber(yield* apply([left[leftIndex], right[rightIndex]]))
        if (Number.isNaN(order) || order <= 0) merged.push(left[leftIndex++])
        else merged.push(right[rightIndex++])
      }
      return [...merged, ...left.slice(leftIndex), ...right.slice(rightIndex)]
    })
  }
  const defined = target.filter((item) => item !== undefined)
  const undefinedCount = target.length - defined.length
  return Effect.map(mergeSort(defined), (items) => [...items, ...Array(undefinedCount).fill(undefined)])
}
