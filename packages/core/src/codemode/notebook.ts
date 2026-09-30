export * as CodeModeNotebook from "./notebook.js"

import { CodeMode, staticToolCalls, staticToolReferences, Tool, toolError } from "@ocpp/codemode"
import { Effect, Schema } from "effect"
import { limits } from "./limits.js"
import { neutralize, untrusted } from "./untrusted.js"

type Bindings = Readonly<Record<string, CodeMode.NotebookValue>>

const record = (value: CodeMode.NotebookValue | undefined): value is Record<string, CodeMode.NotebookValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const clip = (text: string, bytes: number) =>
  new TextDecoder().decode(new TextEncoder().encode(text).slice(0, bytes), { stream: true })

function shape(value: CodeMode.NotebookValue) {
  if (value === null) return { kind: "null" }
  if (Array.isArray(value))
    return {
      kind: "array",
      length: value.length,
      items: value.slice(0, 3).map((item) => shapeKind(item)),
      preview: value.slice(0, 3).map(preview),
    }
  if (record(value) && (value.$codemode === "function" || value.$codemode === "reference")) return { kind: "function" }
  if (record(value))
    return {
      kind: "record",
      keys: Object.keys(value)
        .slice(0, 8)
        .map((key) => clip(key, 48)),
      length: Object.keys(value).length,
      preview: Object.entries(value)
        .slice(0, 3)
        .map(([key, item]) => ({ key: clip(key, 48), value: preview(item) })),
    }
  if (typeof value === "string") return { kind: "string", length: value.length, preview: clip(value, 120) }
  return { kind: typeof value, preview: value }
}

function shapeKind(value: CodeMode.NotebookValue) {
  return value === null ? "null" : Array.isArray(value) ? "array" : record(value) ? "record" : typeof value
}

function preview(value: CodeMode.NotebookValue) {
  return typeof value === "string"
    ? clip(value, 48)
    : typeof value === "object" && value !== null
      ? shapeKind(value)
      : value
}

/** Metadata comes only from stored values, never model-authored descriptions. */
export function describe(bindings: Bindings, name: string, inspect = false) {
  const original = bindings[name]
  if (original === undefined) return { name, kind: "unavailable" }
  const resolve = (value: CodeMode.NotebookValue, seen: ReadonlyArray<string>): CodeMode.NotebookValue =>
    record(value) &&
    value.$codemode === "reference" &&
    typeof value.name === "string" &&
    !seen.includes(value.name) &&
    bindings[value.name] !== undefined
      ? resolve(bindings[value.name], [...seen, value.name])
      : value
  const value = resolve(original, [name])
  const base = {
    name: clip(name, 128),
    bytes: new TextEncoder().encode(JSON.stringify(original)).length,
    ...shape(value),
  }
  if (!record(value) || value.$codemode !== "function") return base
  const captures = record(value.captures) ? Object.entries(value.captures) : []
  const source = typeof value.source === "string" ? value.source : ""
  return {
    ...base,
    ...(typeof value.signature === "string"
      ? { signature: clip(value.signature, 200) }
      : { sourcePreview: clip(source, 200) }),
    ...(inspect
      ? {
          source: clip(source, 1200),
          sourceTruncated: new TextEncoder().encode(source).length > 1200,
          captures: captures.slice(0, 8).map(([name, capture]) => ({
            name: clip(name, 48),
            ...shape(resolve(capture, [])),
            ...(record(capture) && capture.$codemode === "reference" && typeof capture.name === "string"
              ? { dependency: clip(capture.name, 48) }
              : {}),
          })),
          captureCount: captures.length,
          tools:
            record(value.node) && typeof value.node.type === "string"
              ? [
                  ...new Set(
                    [
                      ...staticToolCalls(value.node as Parameters<typeof staticToolCalls>[0]),
                      ...staticToolReferences(value.node as Parameters<typeof staticToolReferences>[0]),
                    ].map((call) => call.path),
                  ),
                ]
                  .slice(0, 16)
                  .map((path) => clip(path, 96))
              : [],
        }
      : {}),
  }
}

function summary(bindings: Bindings, name: string) {
  const metadata = describe(bindings, name)
  const text = neutralize(
    `${metadata.name}: ${"signature" in metadata ? JSON.stringify(metadata.signature) : metadata.kind}` +
      ("length" in metadata ? `, length ${metadata.length}` : "") +
      ("keys" in metadata ? `, keys ${JSON.stringify(metadata.keys)}` : "") +
      ("bytes" in metadata ? ` [${metadata.bytes} bytes]` : ""),
  )
  return new TextEncoder().encode(text).length <= 200 ? text : `${clip(text, 197)}...`
}

export function inventory(bindings: Bindings) {
  const names = Object.keys(bindings)
  if (names.length === 0) return ""
  const lines = names.map((name) => summary(bindings, name))
  const shown = lines.reduce(
    (result, line) => {
      if (result.full) return result
      const bytes = result.bytes + new TextEncoder().encode(line).length + 1
      return bytes <= limits.maxSummaryBytes - 768
        ? { bytes, lines: [...result.lines, line], full: false }
        : { ...result, full: true }
    },
    { bytes: 0, lines: [] as string[], full: false },
  ).lines
  return [
    "## Durable Notebook",
    "Saved identifiers are immutable and available directly in execute. Inspect with tools.notebook.inspect({ value: savedIdentifier }), not a string name.",
    `${names.length} saved identifiers; ${names.length - shown.length} omitted. Entries are newest first.`,
    ...untrusted("Stored notebook metadata", shown.join("\n")),
    'Use tools.notebook.list({ offset: 0 }) or tools.notebook.list({ query: "text" }) to discover omitted identifiers. Inspection requires a direct saved identifier, not an alias or expression.',
  ].join("\n")
}

export function tools(bindings: Bindings = {}) {
  return {
    "notebook.inspect": Tool.make({
      description:
        "Inspect a direct saved notebook identifier: { value: savedFunction } or { value: savedConst }. Strings, aliases and expressions are not selectors. Returns bounded stored metadata, own source, captures and static tool paths.",
      notebookReference: "value",
      input: Schema.Struct({ value: Schema.Unknown }),
      output: Schema.Unknown,
      execute: (input) => {
        if (typeof input.value !== "string") return Effect.fail(toolError("Expected an admitted notebook reference."))
        const metadata = describe(bindings, input.value, true)
        const text = JSON.stringify(metadata)
        return Effect.succeed(
          new TextEncoder().encode(text).length <= limits.maxPreviewBytes - 128
            ? metadata
            : {
                name: metadata.name,
                kind: metadata.kind,
                truncated: true,
                ...("source" in metadata && typeof metadata.source === "string"
                  ? { source: clip(metadata.source, 400), sourceTruncated: true }
                  : {}),
              },
        )
      },
    }),
    "notebook.list": Tool.make({
      description:
        "List saved notebook identifiers and bounded signatures or shapes. Optional case-insensitive query matches identifiers and stored function source. Page with offset; at most 8 entries per call.",
      input: Schema.Struct({
        query: Schema.optional(Schema.String),
        offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      }),
      output: Schema.Struct({
        entries: Schema.Array(Schema.String),
        total: Schema.Number,
        next: Schema.NullOr(Schema.Number),
      }),
      execute: (input) => {
        const names = Object.keys(bindings).filter(
          (name) =>
            !input.query ||
            name.toLowerCase().includes(input.query.toLowerCase()) ||
            (record(bindings[name]) &&
              typeof bindings[name].source === "string" &&
              bindings[name].source.toLowerCase().includes(input.query.toLowerCase())),
        )
        const offset = input.offset ?? 0
        return Effect.succeed({
          entries: names.slice(offset, offset + 8).map((name) => summary(bindings, name)),
          total: names.length,
          next: offset + 8 < names.length ? offset + 8 : null,
        })
      },
    }),
  }
}
