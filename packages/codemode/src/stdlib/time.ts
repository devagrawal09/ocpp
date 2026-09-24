import { type AstNode, InterpreterRuntimeError } from "../interpreter/model.js"
import type { SafeObject } from "../tool-runtime.js"
import { boundedData, coerceToNumber } from "./value.js"

/**
 * Time is plain data: epoch milliseconds and ISO 8601 strings. `now` reads host authority and is the
 * only impure member; every other member is a deterministic transformation.
 */
export const timeMethods = new Set(["now", "parse", "format", "parts", "fromParts", "add", "diff"])

const units: Record<string, number> = {
  milliseconds: 1,
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
  weeks: 604_800_000,
}

const fail = (message: string, node: AstNode) =>
  new InterpreterRuntimeError(message, node, "InvalidDataValue").as("TypeError")

const epoch = (name: string, value: unknown, node: AstNode): number => {
  const time = coerceToNumber(value)
  if (!Number.isFinite(time)) throw fail(`time.${name} expects epoch milliseconds.`, node)
  return time
}

const record = (entries: ReadonlyArray<readonly [string, unknown]>): SafeObject =>
  Object.assign(Object.create(null) as SafeObject, Object.fromEntries(entries))

const requireRecord = (name: string, value: unknown, node: AstNode): Record<string, unknown> => {
  const data = boundedData(value, `time.${name} input`)
  if (data === null || typeof data !== "object" || Array.isArray(data))
    throw fail(`time.${name} expects a record.`, node)
  return data as Record<string, unknown>
}

const number = (source: Record<string, unknown>, key: string, fallback: number, name: string, node: AstNode) => {
  const value = source[key]
  if (value === undefined) return fallback
  const parsed = coerceToNumber(value)
  if (!Number.isFinite(parsed)) throw fail(`time.${name} expects '${key}' to be a finite number.`, node)
  return parsed
}

export const invokeTimeMethod = (name: string, args: Array<unknown>, node: AstNode): unknown => {
  switch (name) {
    case "now":
      return Date.now()
    case "parse": {
      if (typeof args[0] !== "string") throw fail("time.parse expects a date string.", node)
      const parsed = Date.parse(args[0])
      return Number.isNaN(parsed) ? null : parsed
    }
    case "format":
      return new Date(epoch("format", args[0], node)).toISOString()
    case "parts": {
      const date = new Date(epoch("parts", args[0], node))
      return record([
        ["year", date.getUTCFullYear()],
        ["month", date.getUTCMonth() + 1],
        ["day", date.getUTCDate()],
        ["hour", date.getUTCHours()],
        ["minute", date.getUTCMinutes()],
        ["second", date.getUTCSeconds()],
        ["millisecond", date.getUTCMilliseconds()],
        ["weekday", date.getUTCDay()],
      ])
    }
    case "fromParts": {
      const parts = requireRecord("fromParts", args[0], node)
      const time = Date.UTC(
        number(parts, "year", 1970, "fromParts", node),
        number(parts, "month", 1, "fromParts", node) - 1,
        number(parts, "day", 1, "fromParts", node),
        number(parts, "hour", 0, "fromParts", node),
        number(parts, "minute", 0, "fromParts", node),
        number(parts, "second", 0, "fromParts", node),
        number(parts, "millisecond", 0, "fromParts", node),
      )
      return Number.isNaN(time) ? null : time
    }
    case "add": {
      const base = epoch("add", args[0], node)
      const amounts = requireRecord("add", args[1], node)
      for (const key of Object.keys(amounts))
        if (!Object.hasOwn(units, key))
          throw fail(`time.add does not support the unit '${key}'; use ${Object.keys(units).join(", ")}.`, node)
      return Object.entries(units).reduce(
        (total, [unit, size]) => total + number(amounts, unit, 0, "add", node) * size,
        base,
      )
    }
    case "diff":
      return epoch("diff", args[0], node) - epoch("diff", args[1], node)
    default:
      throw new InterpreterRuntimeError(`time.${name} is not available.`, node)
  }
}
