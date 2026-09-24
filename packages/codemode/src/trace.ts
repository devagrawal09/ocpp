import type { Effect } from "effect"
import { formatConsoleMessage } from "./stdlib/console.js"

export type TraceEvent =
  | { readonly kind: "assignment"; readonly target: string; readonly value: string }
  | { readonly kind: "branch"; readonly expression: string; readonly result: boolean }
  | { readonly kind: "operation"; readonly operation: string; readonly input: string; readonly output: string }
  | { readonly kind: "log"; readonly method: string; readonly message: string }
  | { readonly kind: "return"; readonly value: string }

export type TraceHook<R = never> = (event: TraceEvent) => Effect.Effect<void, never, R>

const MAX_ITEMS = 4
const MAX_TEXT = 200

export function traceValue(value: unknown): string {
  const text = Array.isArray(value)
    ? traceArray(value)
    : value !== null && typeof value === "object" && Object.getPrototypeOf(value) === null
      ? traceRecord(value as Record<string, unknown>)
      : formatConsoleMessage("dir", [value])
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 1)}...`
}

function traceArray(value: Array<unknown>) {
  const shown = value.slice(0, MAX_ITEMS).map(traceValue).join(", ")
  const omitted = value.length > MAX_ITEMS ? ", ..." : ""
  return `[${shown}${omitted}] (${value.length} items)`
}

function traceRecord(value: Record<string, unknown>) {
  const entries = Object.entries(value)
  const shown = entries
    .slice(0, MAX_ITEMS)
    .map(([key, item]) => `${key}: ${traceValue(item)}`)
    .join(", ")
  return `{ ${shown}${entries.length > MAX_ITEMS ? ", ..." : ""} }`
}

export function traceSource(
  source: string,
  node: { readonly type: string; start?: unknown; end?: unknown },
  fallback: string,
) {
  if (typeof node.start !== "number" || typeof node.end !== "number") return fallback
  const text = source.slice(node.start, node.end).replace(/\s+/g, " ").trim()
  if (text === "") return fallback
  return text.length <= 120 ? text : `${text.slice(0, 119)}...`
}
