export * as CodeModeDiagnosticsTaxonomy from "./diagnostics-taxonomy.js"

import { Schema } from "effect"

/**
 * Deterministic failure taxonomy for Code Mode diagnostics.
 *
 * Structured fields always win: a refusal or completion that carries a `kind` is classified by
 * that kind, and a typed session error is classified by its `type`. Only records without any
 * structured field fall through to the ordered rule tables below, which match the normalized
 * first line of the message. That fallback is recorded on every classification so a consumer can
 * tell a persisted fact from a pattern match, and anything no rule matches stays `unclassified`
 * rather than being guessed.
 */

const SIGNATURE_LENGTH = 240

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const text = (value: unknown) => (typeof value === "string" ? value : value == null ? "" : JSON.stringify(value))

/** First line, lowercased, with identifiers, hashes, paths, and numbers replaced by placeholders. */
export const normalize = (value: unknown) =>
  (
    text(value)
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  )
    .toLowerCase()
    .replace(/\b(?:ses|exe|msg|call)_[a-z0-9_-]+\b/gi, "<id>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hash>")
    .replace(/(?:\/[^\s:]+)+/g, "<path>")
    .replace(/\b\d+(?:[.:_-]\d+)*\b/g, "<num>")
    .replace(/\s+/g, " ")
    .slice(0, SIGNATURE_LENGTH)

const Json = Schema.fromJsonString(Schema.Unknown)

/** A persisted session error: its typed category and message, from JSON text or a decoded record. */
export const sessionError = (value: unknown): { readonly type?: string; readonly message: string } => {
  const parsed = typeof value === "string" ? Schema.decodeUnknownOption(Json)(value) : undefined
  const decoded = parsed?._tag === "Some" ? parsed.value : value
  if (!isRecord(decoded)) return { message: text(value) }
  return {
    ...(typeof decoded.type === "string" ? { type: decoded.type } : {}),
    message: typeof decoded.message === "string" ? decoded.message : text(value),
  }
}

export type Rule = { readonly name: string; readonly category: string; readonly pattern: RegExp }

/** Ordered rules over a normalized refusal message. The first match wins. */
export const refusalRules: ReadonlyArray<Rule> = [
  {
    name: "concurrency-limit",
    category: "ConcurrencyLimit",
    pattern: /^(?:at most <num> executions may run|code mode allows at most <num> concurrent executions)/,
  },
  { name: "await", category: "Compatibility", pattern: /^await is not supported/ },
  { name: "promise", category: "UnsupportedSyntax", pattern: /^promise is not supported/ },
  { name: "regex", category: "UnsupportedSyntax", pattern: /^regular expressions are not available/ },
  {
    name: "removed-global",
    category: "UnsupportedSyntax",
    pattern: /^(?:set|map|date|url|urlsearchparams) is not a value/,
  },
  { name: "mutation", category: "UnsupportedSyntax", pattern: /^(?:mutating method|arrays and objects are immutable)/ },
  {
    name: "tool-path",
    category: "UnsupportedSyntax",
    pattern: /^(?:tools must be called through|the tool namespace only)/,
  },
  { name: "unsupported-syntax", category: "UnsupportedSyntax", pattern: /^syntax '.*' is not supported/ },
  { name: "parse", category: "ParseError", pattern: /^(?:failed to parse|invalid compiler node)/ },
  {
    name: "durable-limit",
    category: "InvalidDurableValue",
    pattern: /^code mode result exceeds the <num>-byte durable/,
  },
  { name: "name-defined", category: "NameAlreadyDefined", pattern: /^notebook names are immutable/ },
  { name: "name-reserved", category: "NameReserved", pattern: /^execution <id> is already running and holds/ },
  {
    name: "notebook-limit",
    category: "NotebookLimitExceeded",
    pattern: /^(?:this session's notebook would hold|one execution may declare at most)/,
  },
  { name: "input-schema", category: "InvalidToolInput", pattern: /^(?:expected number|invalid arguments for tool)/ },
  {
    name: "legacy-wrapper",
    category: "LegacyWrappedFailure",
    pattern: /^execution <id> failed \(<num> durable bytes\)/,
  },
]

/** Ordered rules over a normalized execution failure message. The first match wins. */
export const failureRules: ReadonlyArray<Rule> = [
  { name: "timeout", category: "TimeoutExceeded", pattern: /^execution timed out after/ },
  {
    name: "tool-input",
    category: "InvalidToolInput",
    pattern: /^(?:invalid arguments for tool|invalid input for tool|expected number)/,
  },
  { name: "unknown-tool", category: "UnknownTool", pattern: /^unknown tool/ },
  { name: "file-not-found", category: "ToolFailure", pattern: /^file not found:/ },
  { name: "path-missing", category: "ToolFailure", pattern: /^search path does not exist/ },
  { name: "regex-invalid", category: "ToolFailure", pattern: /^invalid regex pattern/ },
  { name: "fetch", category: "ToolFailure", pattern: /^unable to fetch/ },
  { name: "offset", category: "ToolFailure", pattern: /^offset <num> is out of range/ },
  { name: "patch", category: "ToolFailure", pattern: /^patch verification failed/ },
  { name: "unsupported-syntax", category: "UnsupportedSyntax", pattern: /^syntax '.*' is not supported/ },
  {
    name: "commit-conflict",
    category: "CommitFailure",
    pattern: /(?:are no longer reserved by this execution|was reverted; nothing was saved|nothing was saved\.$)/,
  },
  {
    name: "restart",
    category: "Interrupted",
    pattern: /^execution (?:failed because the server restarted|became indeterminate)/,
  },
  {
    name: "legacy-wrapper",
    category: "LegacyWrappedFailure",
    pattern: /^execution <id> failed \(<num> durable bytes\)/,
  },
  { name: "uncaught", category: "ExecutionFailure", pattern: /^uncaught:/ },
  { name: "unknown-identifier", category: "ExecutionFailure", pattern: /^unknown identifier '/ },
  { name: "json-parse", category: "ExecutionFailure", pattern: /^json\.parse received invalid json/ },
  { name: "edit-mismatch", category: "ToolFailure", pattern: /^could not find oldstring in/ },
  { name: "command-spawn", category: "ToolFailure", pattern: /^unable to execute command/ },
  { name: "unknown-agent", category: "ToolFailure", pattern: /^unknown agent:/ },
  { name: "browser", category: "ToolFailure", pattern: /^could not connect to chrome/ },
  { name: "question-dismissed", category: "UserDismissed", pattern: /^the user dismissed this question/ },
  { name: "fiber-interrupt", category: "Interrupted", pattern: /^all fibers interrupted without error/ },
  { name: "cancelled", category: "Interrupted", pattern: /^execution cancelled$/ },
]

/** Ordered rules over a normalized nested tool error. The first match wins. */
export const journalRules: ReadonlyArray<Rule> = [
  { name: "tool-input", category: "InvalidToolInput", pattern: /^invalid arguments for tool/ },
  { name: "file-not-found", category: "NotFound", pattern: /^(?:file not found|search path does not exist)/ },
  { name: "regex-invalid", category: "InvalidPattern", pattern: /^invalid regex pattern/ },
  { name: "fetch", category: "Network", pattern: /^unable to fetch/ },
  { name: "timeout", category: "Timeout", pattern: /(?:timed out|exceeded timeout)/ },
  { name: "permission", category: "Permission", pattern: /(?:permission|denied)/ },
  {
    name: "patch",
    category: "VerificationFailed",
    pattern: /^(?:patch verification failed|could not find oldstring in)/,
  },
  { name: "question-dismissed", category: "UserDismissed", pattern: /^the user dismissed this question/ },
  { name: "fiber-interrupt", category: "Interrupted", pattern: /^all fibers interrupted without error/ },
  { name: "command-spawn", category: "SpawnFailure", pattern: /^unable to execute command/ },
]

/** The legacy synchronous wrapper embedded the inner diagnostic as JSON text; its kind is quoted verbatim. */
const legacyKind = /"kind":\s*"([a-z]+)"/i

export type Classification = {
  readonly category: string
  /** Which evidence produced the category, from strongest to weakest. */
  readonly source: "structured-kind" | "structured-type" | "rule" | "unclassified"
  readonly rule?: string
  /** The persisted kind or typed error, when one existed. */
  readonly structured?: string
  readonly signature: string
}

const applyRules = (rules: ReadonlyArray<Rule>, signature: string) => rules.find((rule) => rule.pattern.test(signature))

/** Typed session error categories that are not Code Mode failures at all. */
const typedCategories: Readonly<Record<string, string>> = {
  aborted: "Interrupted",
  "permission.rejected": "PermissionRejected",
}

export const classifyRefusal = (input: { readonly kind?: string; readonly error: unknown }): Classification => {
  const error = sessionError(input.error)
  const signature = normalize(error.message)
  if (input.kind !== undefined)
    return { category: input.kind, source: "structured-kind", structured: input.kind, signature }
  if (error.type !== undefined && error.type.startsWith("provider."))
    return { category: "Provider", source: "structured-type", structured: error.type, signature }
  if (error.type !== undefined && typedCategories[error.type] !== undefined)
    return { category: typedCategories[error.type]!, source: "structured-type", structured: error.type, signature }
  const rule = applyRules(refusalRules, signature)
  if (rule === undefined) return { category: "unclassified", source: "unclassified", signature }
  const inner = rule.name === "legacy-wrapper" ? legacyKind.exec(error.message)?.[1] : undefined
  return {
    category: inner === undefined ? rule.category : "Legacy:" + inner,
    source: "rule",
    rule: rule.name,
    signature,
  }
}

/** A failure whose only persisted evidence is its state; there is no text to classify at all. */
export const NO_ERROR_RECORDED = "NoErrorRecorded"

export const classifyFailure = (input: { readonly kind?: string; readonly error: unknown }): Classification => {
  const message = sessionError(input.error).message
  const signature = normalize(message)
  if (input.kind !== undefined)
    return { category: input.kind, source: "structured-kind", structured: input.kind, signature }
  if (signature === "") return { category: NO_ERROR_RECORDED, source: "unclassified", signature }
  const rule = applyRules(failureRules, signature)
  if (rule === undefined) return { category: "unclassified", source: "unclassified", signature }
  const inner = rule.name === "legacy-wrapper" ? legacyKind.exec(message)?.[1] : undefined
  return {
    category: inner === undefined ? rule.category : "Legacy:" + inner,
    source: "rule",
    rule: rule.name,
    signature,
  }
}

export const classifyJournal = (input: {
  readonly status: string
  readonly error: string | null
  readonly exit: number | null
}): Classification => {
  const signature = normalize(input.error ?? "")
  if (input.status === "completed" && input.exit !== null && input.exit !== 0)
    return { category: "NonzeroExit", source: "structured-type", structured: "exit " + input.exit, signature }
  if (input.status === "completed")
    return { category: "Completed", source: "structured-type", structured: "completed", signature }
  if (input.status === "indeterminate")
    return { category: "Indeterminate", source: "structured-type", structured: input.status, signature }
  if (input.status !== "failed") return { category: "unclassified", source: "unclassified", signature }
  const rule = applyRules(journalRules, signature)
  if (rule === undefined) return { category: "unclassified", source: "unclassified", signature }
  return { category: rule.category, source: "rule", rule: rule.name, signature }
}

/** Whitespace-insensitive identity of a program; the weakest textual retry relationship. */
export const normalizedSource = (code: string) => code.replace(/\s+/g, " ").trim()

/**
 * A structural identity of a program: the sorted static tool paths it calls plus the top-level
 * names it declares. Two programs with the same fingerprint retry the same tools under the same
 * names even when their arguments changed. Tool paths and declarations are recognized by lexical
 * shape only; no parser is involved, so the fingerprint is stable but deliberately coarse.
 */
export const EMPTY_FINGERPRINT = "|"

export const fingerprint = (code: string) => {
  const paths = [...new Set([...code.matchAll(/\btools(?:\.[A-Za-z_$][\w$]*)+/g)].map((match) => match[0]))].sort()
  const names = [
    ...new Set([...code.matchAll(/^\s*(?:const|function)\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]!)),
  ].sort()
  return paths.join(",") + "|" + names.join(",")
}

/** The rule tables in a serializable form, for the report manifest. */
export const published = {
  precedence: ["structured-kind", "structured-type", "rule", "unclassified"],
  refusalRules: refusalRules.map((rule) => ({
    name: rule.name,
    category: rule.category,
    pattern: rule.pattern.source,
  })),
  failureRules: failureRules.map((rule) => ({
    name: rule.name,
    category: rule.category,
    pattern: rule.pattern.source,
  })),
  journalRules: journalRules.map((rule) => ({
    name: rule.name,
    category: rule.category,
    pattern: rule.pattern.source,
  })),
  typedCategories,
  signatureLength: SIGNATURE_LENGTH,
}
