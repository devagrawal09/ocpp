export * as CodeModeDiagnostics from "./diagnostics.js"

import { Effect, Schema } from "effect"
import { CodeModeDiagnosticsStats } from "./diagnostics-stats.js"
import { CodeModeDiagnosticsTaxonomy } from "./diagnostics-taxonomy.js"

/**
 * Offline, read-only analysis of Code Mode outcomes in a frozen database snapshot.
 *
 * The execute tool returns as soon as a program is admitted, so a completed tool record proves
 * admission, not success. Every execute call is therefore joined to its execution row and its
 * completion notification before anything is counted, and admission and completion are always
 * reported side by side. Classification is structured first and falls back to published rule
 * tables only for historical records that carry no structured field, recording which it was.
 *
 * The report is a pure function of the input rows and options: inputs are sorted canonically on
 * entry, every grouping has a total order, no timestamps are generated, and `stringify` writes
 * object keys in sorted order, so identical input bytes produce identical output bytes.
 */

export const SCHEMA = "opencode.codemode-diagnostics/4"
/** Bump when a change alters what a report counts, so reports from different analyzers never mix. */
export const VERSION = 4

/** Execute calls examined after a failure before an episode is closed as unrecovered. */
const FOLLOWUP_CALLS = 5
/** Consecutive identical refused programs that count as a blind retry loop. */
const REFUSAL_LOOP_MINIMUM = 3
const SIGNATURE_LIMIT = 40
const EXAMPLE_LIMIT = 3
const EPISODE_EXAMPLE_LIMIT = 40
const SEQUENCE_LIMIT = 40
const COHORT_VALUE_LIMIT = 20
const EVENT_EXAMPLE_LIMIT = 12
const CODE_PREVIEW_LENGTH = 120

export const queries = {
  columns: "pragma table_info(session_v2)",
  // Snapshots taken before the idle error columns existed are still readable.
  sessions: (withError: boolean) =>
    "select id, project_id, parent_id, version, cost, time_created, time_idle, idle_outcome" +
    (withError ? ", idle_error_type, idle_error_message" : "") +
    " from session_v2 order by id",
  messages:
    "select id, session_id, type, seq, data from session_message where type in ('assistant', 'synthetic') order by session_id, seq, id",
  executions:
    "select id, session_id, assistant_message_id, tool_call_id, status, error, time_created, time_completed from codemode_execution order by id",
  journal:
    "select execution_id, call_index, tool, status, output, error from codemode_journal order by execution_id, call_index",
} as const

// Raw SQLite readers return JSON columns as text; drizzle returns them decoded. Accept both.
const Json = Schema.fromJsonString(Schema.Unknown)

const SessionRow = Schema.Struct({
  id: Schema.String,
  project_id: Schema.String,
  parent_id: Schema.NullOr(Schema.String),
  version: Schema.String,
  cost: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  time_created: Schema.Number,
  time_idle: Schema.NullOr(Schema.Number),
  idle_outcome: Schema.NullOr(Schema.String),
  idle_error_type: Schema.optionalKey(Schema.NullOr(Schema.String)),
  idle_error_message: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
const MessageRow = Schema.Struct({
  id: Schema.String,
  session_id: Schema.String,
  type: Schema.String,
  seq: Schema.Number,
  data: Schema.Union([Json, Schema.Unknown]),
})
const ExecutionRow = Schema.Struct({
  id: Schema.String,
  session_id: Schema.String,
  assistant_message_id: Schema.String,
  tool_call_id: Schema.String,
  status: Schema.String,
  error: Schema.NullOr(Schema.String),
  time_created: Schema.Number,
  time_completed: Schema.NullOr(Schema.Number),
})
const JournalRow = Schema.Struct({
  execution_id: Schema.String,
  call_index: Schema.Number,
  tool: Schema.String,
  status: Schema.String,
  output: Schema.NullOr(Schema.Union([Json, Schema.Unknown])),
  error: Schema.NullOr(Schema.String),
})

export type Input = {
  readonly sessions: ReadonlyArray<typeof SessionRow.Type>
  readonly messages: ReadonlyArray<typeof MessageRow.Type>
  readonly executions: ReadonlyArray<typeof ExecutionRow.Type>
  readonly journal: ReadonlyArray<typeof JournalRow.Type>
  /** The exact statements the rows came from, recorded in the report manifest. */
  readonly queries?: Readonly<Record<string, string>>
}

const decodeColumns = Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ name: Schema.String })))
const decodeSessions = Schema.decodeUnknownSync(Schema.Array(SessionRow))
const decodeMessages = Schema.decodeUnknownSync(Schema.Array(MessageRow))
const decodeExecutions = Schema.decodeUnknownSync(Schema.Array(ExecutionRow))
const decodeJournal = Schema.decodeUnknownSync(Schema.Array(JournalRow))

/** Reads the four tables through any query runner, so a script and a test share one loader. */
export const load = (run: (text: string) => Effect.Effect<ReadonlyArray<unknown>>): Effect.Effect<Input> =>
  Effect.gen(function* () {
    const columns = decodeColumns(yield* run(queries.columns)).map((column) => column.name)
    const sessions = queries.sessions(columns.includes("idle_error_type"))
    return {
      ...(yield* Effect.all({
        sessions: run(sessions).pipe(Effect.map(decodeSessions)),
        messages: run(queries.messages).pipe(Effect.map(decodeMessages)),
        executions: run(queries.executions).pipe(Effect.map(decodeExecutions)),
        journal: run(queries.journal).pipe(Effect.map(decodeJournal)),
      })),
      queries: { sessions, messages: queries.messages, executions: queries.executions, journal: queries.journal },
    }
  })

export type Options = {
  /** Newest terminal sessions held out from signature discovery; recurrence there is reported. */
  readonly holdout?: number
  readonly snapshot?: { readonly path: string; readonly sha256: string }
}

/** JSON with keys in sorted order at every level, so equal reports serialize to equal bytes. */
export const stringify = (value: unknown): string => JSON.stringify(canonical(value), null, 2)

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort(compareString)
      .flatMap((key) => (value[key] === undefined ? [] : [[key, canonical(value[key])]])),
  )
}

/** Where a counted record lives, so every number in a report can be traced back to a row. */
type Provenance = {
  readonly sessionID: string
  readonly messageID: string
  readonly seq: number
  readonly index: number
  readonly executionID?: string
}

type Classification = CodeModeDiagnosticsTaxonomy.Classification

type Call = Provenance & {
  readonly version: string
  readonly mode: "sync" | "async" | "unknown"
  readonly providerID: string | null
  readonly modelID: string | null
  readonly child: boolean
  readonly ordinal: number
  readonly code: string
  /** How the execution ID was recovered from the persisted tool state. */
  readonly executionIDSource: "metadata" | "content" | "none"
  /** The tool record settled: the program was admitted (async) or ran to completion (sync). */
  readonly admitted: boolean
  readonly refusal?: Classification
  /** Terminal state of the admitted execution and which record decided it. */
  readonly completion: "saved" | "failed" | "indeterminate" | "cancelled" | "running" | "unknown"
  readonly completionSource: "execution" | "notification" | "lifecycle" | "tool" | "none"
  readonly failure?: Classification
  readonly durationMs: number | null
}

type ToolRecord = Provenance & { readonly name: string; readonly status: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const compareString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const groupBy = <T>(values: ReadonlyArray<T>, key: (value: T) => string) =>
  values.reduce((groups, value) => {
    const name = key(value)
    return groups.set(name, [...(groups.get(name) ?? []), value])
  }, new Map<string, T[]>())

const count = <T>(values: ReadonlyArray<T>, key: (value: T) => string) =>
  [...groupBy(values, key)]
    .map(([name, rows]) => ({ name, count: rows.length }))
    .sort((a, b) => b.count - a.count || compareString(a.name, b.name))

const sessionsOf = (values: ReadonlyArray<{ sessionID: string }>) => new Set(values.map((row) => row.sessionID)).size

const evidence = <T>(values: ReadonlyArray<T>) => ({ count: values.length, examples: values.slice(0, EXAMPLE_LIMIT) })

const provenance = (call: Provenance): Provenance => ({
  sessionID: call.sessionID,
  messageID: call.messageID,
  seq: call.seq,
  index: call.index,
  ...(call.executionID ? { executionID: call.executionID } : {}),
})

const byProvenance = (a: Provenance, b: Provenance) =>
  compareString(a.sessionID, b.sessionID) ||
  a.seq - b.seq ||
  a.index - b.index ||
  compareString(a.messageID, b.messageID)

const uniqueSorted = (values: ReadonlyArray<string>) => [...new Set(values)].sort(compareString)

const duplicates = (values: ReadonlyArray<string>) =>
  [...groupBy(values, (value) => value)]
    .filter(([, rows]) => rows.length > 1)
    .map(([id]) => id)
    .sort(compareString)

export const analyze = (input: Input, options: Options = {}) => {
  const stats = CodeModeDiagnosticsStats
  const taxonomy = CodeModeDiagnosticsTaxonomy
  const holdoutSize = options.holdout ?? 30

  // Canonical input order: the report must not depend on how rows arrived.
  const sessionRows = input.sessions.toSorted((a, b) => compareString(a.id, b.id))
  const messageRows = input.messages.toSorted(
    (a, b) => compareString(a.session_id, b.session_id) || a.seq - b.seq || compareString(a.id, b.id),
  )
  const executionRows = input.executions.toSorted((a, b) => compareString(a.id, b.id))
  const journalRows = input.journal.toSorted(
    (a, b) =>
      compareString(a.execution_id, b.execution_id) || a.call_index - b.call_index || compareString(a.tool, b.tool),
  )

  const sessions = new Map(sessionRows.map((session) => [session.id, session]))
  const terminal = sessionRows.filter((session) => session.time_idle !== null)
  const terminalIDs = new Set(terminal.map((session) => session.id))
  const holdout = new Set(
    terminal
      .toSorted((a, b) => b.time_created - a.time_created || compareString(b.id, a.id))
      .slice(0, holdoutSize)
      .map((session) => session.id),
  )
  const executions = new Map(executionRows.map((execution) => [execution.id, execution]))
  const scopedExecutions = executionRows.filter((execution) => terminalIDs.has(execution.session_id))

  // Completion notifications carry the execution ID and, on current versions, the failure kind.
  const notificationRows = messageRows.flatMap((message) => {
    if (message.type !== "synthetic" || !isRecord(message.data)) return []
    const metadata = message.data.metadata
    if (!isRecord(metadata) || metadata.source !== "codemode" || typeof metadata.executionID !== "string") return []
    return [
      {
        executionID: metadata.executionID,
        sessionID: message.session_id,
        messageID: message.id,
        seq: message.seq,
        state: typeof metadata.state === "string" ? metadata.state : "unknown",
        ...(typeof metadata.kind === "string" ? { kind: metadata.kind } : {}),
      },
    ]
  })
  const notifications = new Map<string, (typeof notificationRows)[number]>()
  for (const row of notificationRows) if (!notifications.has(row.executionID)) notifications.set(row.executionID, row)

  const tools: ToolRecord[] = []
  const calls: Call[] = []
  const assistantWithoutModel: Provenance[] = []
  for (const message of messageRows) {
    if (message.type !== "assistant" || !isRecord(message.data) || !Array.isArray(message.data.content)) continue
    const session = sessions.get(message.session_id)
    if (!session || session.time_idle === null) continue
    const model = isRecord(message.data.model) ? message.data.model : undefined
    const providerID = typeof model?.providerID === "string" ? model.providerID : null
    const modelID = typeof model?.id === "string" ? model.id : null
    if (providerID === null)
      assistantWithoutModel.push({ sessionID: message.session_id, messageID: message.id, seq: message.seq, index: -1 })
    message.data.content.forEach((content, index) => {
      if (!isRecord(content) || content.type !== "tool" || typeof content.name !== "string") return
      const state = isRecord(content.state) ? content.state : {}
      const status = typeof state.status === "string" ? state.status : "unknown"
      const where = { sessionID: message.session_id, messageID: message.id, seq: message.seq, index }
      tools.push({ ...where, name: content.name, status })
      if (content.name !== "execute") return
      const inputValue = isRecord(state.input) ? state.input : {}
      const metadata = isRecord(state.metadata) ? state.metadata : {}
      // Persisted tool state keeps no declared output. The execution ID arrives through the
      // lifecycle events that update the tool's metadata, and the admission text names it too.
      const contentText = Array.isArray(state.content)
        ? state.content
            .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
            .join("\n")
        : ""
      const started = /^Execution (exe_[A-Za-z0-9]+) started\b/.exec(contentText)
      const executionID =
        typeof metadata.executionID === "string" ? metadata.executionID : started === null ? undefined : started[1]!
      const executionIDSource = typeof metadata.executionID === "string" ? "metadata" : started ? "content" : "none"
      const kind = typeof metadata.kind === "string" ? metadata.kind : undefined
      const execution = executionID ? executions.get(executionID) : undefined
      const base = {
        ...where,
        ...(executionID ? { executionID } : {}),
        version: session.version,
        providerID,
        modelID,
        child: session.parent_id !== null,
        ordinal: 0,
        code: typeof inputValue.code === "string" ? inputValue.code : "",
        executionIDSource,
        durationMs:
          execution && execution.time_completed !== null ? execution.time_completed - execution.time_created : null,
      } as const
      if (status === "error") {
        // A refused call never received an execution ID (compile, admission, and concurrency
        // refusals). An errored call that has one ran synchronously on an older version.
        if (executionID === undefined) {
          calls.push({
            ...base,
            mode: "unknown",
            admitted: false,
            refusal: taxonomy.classifyRefusal({ kind, error: state.error }),
            completion: "unknown",
            completionSource: "none",
          })
          return
        }
        calls.push({
          ...base,
          mode: "sync",
          admitted: true,
          completion: "failed",
          completionSource: "tool",
          failure: taxonomy.classifyFailure({ kind, error: state.error }),
        })
        return
      }
      if (status !== "completed") return
      // An asynchronous admission says so in its text and is later stamped with a lifecycle
      // status; a synchronous record from an older version has neither.
      const lifecycle = typeof metadata.executionStatus === "string" ? metadata.executionStatus : undefined
      const async = started !== null || lifecycle !== undefined
      const notification = executionID ? notifications.get(executionID) : undefined
      const completion = execution
        ? execution.status === "saved"
          ? "saved"
          : execution.status === "failed"
            ? "failed"
            : execution.status === "indeterminate"
              ? "indeterminate"
              : execution.status === "running" || execution.status === "scheduled"
                ? "running"
                : "unknown"
        : notification
          ? notification.state === "completed"
            ? "saved"
            : notification.state === "cancelled"
              ? "cancelled"
              : notification.state === "failed" || notification.state === "error"
                ? "failed"
                : "unknown"
          : lifecycle === "completed"
            ? "saved"
            : lifecycle === "error"
              ? "failed"
              : lifecycle === "cancelled"
                ? "cancelled"
                : async
                  ? "unknown"
                  : "saved"
      const completionSource = execution
        ? "execution"
        : notification
          ? "notification"
          : lifecycle !== undefined
            ? "lifecycle"
            : async
              ? "none"
              : "tool"
      calls.push({
        ...base,
        mode: async ? "async" : executionID ? "sync" : "unknown",
        admitted: true,
        completion,
        completionSource,
        ...(completion === "failed" || completion === "indeterminate" || completion === "cancelled"
          ? {
              failure: taxonomy.classifyFailure({
                kind: notification?.kind,
                error: execution?.error ?? (completion === "cancelled" ? "Execution cancelled" : ""),
              }),
            }
          : {}),
      })
    })
  }
  const ordered = [...groupBy(calls, (call) => call.sessionID)]
    .sort(([a], [b]) => compareString(a, b))
    .flatMap(([, rows]) => rows.toSorted(byProvenance).map((call, ordinal) => ({ ...call, ordinal })))
  const bySession = groupBy(ordered, (call) => call.sessionID)
  const orderedTools = tools.toSorted(byProvenance)
  const callByExecution = new Map(
    ordered.flatMap((call) => (call.executionID ? [[call.executionID, call] as const] : [])),
  )

  // Canonical events: every persisted fact about a terminal session in one total order.
  const events = [
    ...orderedTools.map((tool) => ({
      sessionID: tool.sessionID,
      seq: tool.seq,
      index: tool.index,
      rank: 0,
      type:
        tool.name === "execute"
          ? "execute." + (tool.status === "error" ? "settled-error" : tool.status)
          : "tool." + tool.status,
      ref: tool.name === "execute" ? undefined : tool.name,
    })),
    ...ordered.flatMap((call) =>
      call.executionID && executions.has(call.executionID)
        ? [
            {
              sessionID: call.sessionID,
              seq: call.seq,
              index: call.index,
              rank: 1,
              type: "execution." + call.completion,
              ref: call.executionID,
            },
          ]
        : [],
    ),
    ...journalRows.flatMap((row) => {
      const call = callByExecution.get(row.execution_id)
      return call
        ? [
            {
              sessionID: call.sessionID,
              seq: call.seq,
              index: call.index,
              rank: 2 + row.call_index,
              type: "journal." + row.status,
              ref: row.tool,
            },
          ]
        : []
    }),
    ...notificationRows
      .filter((row) => terminalIDs.has(row.sessionID))
      .map((row) => ({
        sessionID: row.sessionID,
        seq: row.seq,
        index: 0,
        rank: 0,
        type: "notification." + row.state,
        ref: row.executionID,
      })),
    ...terminal.map((session) => ({
      sessionID: session.id,
      seq: Number.MAX_SAFE_INTEGER,
      index: 0,
      rank: 0,
      type: "session." + (session.idle_outcome ?? "unknown"),
      ref: session.idle_error_type ?? undefined,
    })),
  ].sort(
    (a, b) =>
      compareString(a.sessionID, b.sessionID) ||
      a.seq - b.seq ||
      a.index - b.index ||
      a.rank - b.rank ||
      compareString(a.type, b.type),
  )
  const eventExampleSession = ordered.find((call) => !call.admitted)?.sessionID ?? ordered[0]?.sessionID

  // Episodes: from a refusal or failed completion through bounded follow-up calls to a real save.
  type Episode = {
    readonly sessionID: string
    /** The call that opened the episode; cohorts key on it and it is never serialized. */
    readonly initialCall: Call
    readonly initial: Provenance & { kind: "refusal" | "failure"; category: string; source: Classification["source"] }
    readonly calls: number
    readonly retries: { exact: number; normalized: number; fingerprint: number; different: number }
    readonly categories: ReadonlyArray<string>
    readonly outcome: "recovered" | "unrecovered" | "unknown"
    readonly closedBy: "saved" | "window" | "session-end"
    readonly recoveryGap: number | null
    readonly version: string
    readonly mode: Call["mode"]
    readonly providerID: string | null
    readonly child: boolean
    readonly holdout: boolean
  }
  const classificationOf = (call: Call) =>
    call.refusal
      ? { kind: "refusal" as const, category: call.refusal.category, source: call.refusal.source }
      : call.failure
        ? { kind: "failure" as const, category: call.failure.category, source: call.failure.source }
        : undefined
  const relation = (previous: Call, next: Call) =>
    previous.code === next.code
      ? "exact"
      : taxonomy.normalizedSource(previous.code) === taxonomy.normalizedSource(next.code)
        ? "normalized"
        : taxonomy.fingerprint(previous.code) !== taxonomy.EMPTY_FINGERPRINT &&
            taxonomy.fingerprint(previous.code) === taxonomy.fingerprint(next.code)
          ? "fingerprint"
          : "different"
  const episodes: Episode[] = []
  for (const rows of bySession.values()) {
    let open: { initial: Call; members: Call[]; unknown: boolean } | undefined
    const close = (outcome: Episode["outcome"], closedBy: Episode["closedBy"], recoveryGap: number | null) => {
      if (!open) return
      const start = classificationOf(open.initial)!
      const members = open.members
      const relations = members.slice(1).map((call, position) => relation(members[position]!, call))
      episodes.push({
        sessionID: open.initial.sessionID,
        initialCall: open.initial,
        initial: { ...provenance(open.initial), ...start },
        calls: members.length,
        retries: {
          exact: relations.filter((value) => value === "exact").length,
          normalized: relations.filter((value) => value === "normalized").length,
          fingerprint: relations.filter((value) => value === "fingerprint").length,
          different: relations.filter((value) => value === "different").length,
        },
        categories: members
          .flatMap((call) => (classificationOf(call) ? [classificationOf(call)!.category] : []))
          .slice(0, 8),
        outcome,
        closedBy,
        recoveryGap,
        version: open.initial.version,
        mode: open.initial.mode,
        providerID: open.initial.providerID,
        child: open.initial.child,
        holdout: holdout.has(open.initial.sessionID),
      })
      open = undefined
    }
    for (const call of rows) {
      if (open) {
        open.members.push(call)
        if (call.completion === "saved") {
          close("recovered", "saved", call.ordinal - open.initial.ordinal)
          continue
        }
        if (call.completion === "unknown" && call.admitted) open.unknown = true
        if (open.members.length - 1 >= FOLLOWUP_CALLS) close(open.unknown ? "unknown" : "unrecovered", "window", null)
        continue
      }
      if (classificationOf(call)) open = { initial: call, members: [call], unknown: false }
    }
    if (open) close(open.unknown ? "unknown" : "unrecovered", "session-end", null)
  }
  episodes.sort((a, b) => byProvenance(a.initial, b.initial))

  const episodeTable = (rows: ReadonlyArray<Episode>) => {
    const decided = rows.filter((episode) => episode.outcome !== "unknown")
    return {
      episodes: rows.length,
      sessions: sessionsOf(rows),
      holdoutSessions: sessionsOf(rows.filter((episode) => episode.holdout)),
      outcomes: count(rows, (episode) => episode.outcome),
      recoveryRate: stats.proportion(rows.filter((episode) => episode.outcome === "recovered").length, decided.length),
      recoveryGap: stats.quantiles(
        rows.flatMap((episode) => (episode.recoveryGap === null ? [] : [episode.recoveryGap])),
      ),
      followups: stats.quantiles(rows.map((episode) => episode.calls - 1)),
      retries: rows.reduce(
        (total, episode) => ({
          exact: total.exact + episode.retries.exact,
          normalized: total.normalized + episode.retries.normalized,
          fingerprint: total.fingerprint + episode.retries.fingerprint,
          different: total.different + episode.retries.different,
        }),
        { exact: 0, normalized: 0, fingerprint: 0, different: 0 },
      ),
    }
  }

  // Classification tables keyed by category, with the evidence source and signatures inside.
  const classificationTable = (
    rows: ReadonlyArray<Call>,
    pick: (call: Call) => Classification | undefined,
    kind: "refusal" | "failure",
  ) =>
    [
      ...groupBy(
        rows.filter((call) => pick(call) !== undefined),
        (call) => pick(call)!.category,
      ),
    ]
      .map(([category, group]) => {
        const own = episodes.filter((episode) => episode.initial.kind === kind && episode.initial.category === category)
        return {
          category,
          occurrences: group.length,
          sessions: sessionsOf(group),
          sources: count(group, (call) => pick(call)!.source),
          rules: count(
            group.filter((call) => pick(call)!.rule !== undefined),
            (call) => pick(call)!.rule!,
          ),
          signatures: count(group, (call) => pick(call)!.signature).slice(0, EXAMPLE_LIMIT),
          versions: count(group, (call) => call.version),
          modes: count(group, (call) => call.mode),
          holdoutOccurrences: group.filter((call) => holdout.has(call.sessionID)).length,
          holdoutSessions: sessionsOf(group.filter((call) => holdout.has(call.sessionID))),
          episodes: episodeTable(own),
          examples: group.slice(0, EXAMPLE_LIMIT).map(provenance),
        }
      })
      .sort((a, b) => b.sessions - a.sessions || b.occurrences - a.occurrences || compareString(a.category, b.category))
      .slice(0, SIGNATURE_LIMIT)

  const refused = ordered.filter((call) => !call.admitted)
  const failed = ordered.filter((call) => call.admitted && call.failure !== undefined)
  const refusals = classificationTable(refused, (call) => call.refusal, "refusal")
  const failures = classificationTable(failed, (call) => call.failure, "failure")

  // Runs of identical refused programs show a model retrying blind; the loop's own kinds explain why.
  const refusalLoops = [...bySession.values()]
    .flatMap((rows) =>
      rows
        .reduce<Call[][]>((runs, call) => {
          const current = runs.at(-1)
          if (current && !call.admitted && !current[0]!.admitted && current[0]!.code === call.code)
            return [...runs.slice(0, -1), [...current, call]]
          return [...runs, [call]]
        }, [])
        .filter((run) => run.length >= REFUSAL_LOOP_MINIMUM && !run[0]!.admitted)
        .map((run) => ({
          sessionID: run[0]!.sessionID,
          length: run.length,
          code: run[0]!.code.slice(0, CODE_PREVIEW_LENGTH),
          categories: count(run, (call) => call.refusal!.category),
          signatures: count(run, (call) => call.refusal!.signature),
          first: provenance(run[0]!),
          last: provenance(run.at(-1)!),
        })),
    )
    .sort((a, b) => b.length - a.length || byProvenance(a.first, b.first))
    .slice(0, 20)

  // Nested calls from the journal, classified structurally by status and exit code.
  const nested = journalRows
    .filter((row) => terminalIDs.has(executions.get(row.execution_id)?.session_id ?? ""))
    .map((row) => {
      const output = isRecord(row.output) ? row.output : {}
      const exit = typeof output.exit === "number" ? output.exit : null
      const classification = taxonomy.classifyJournal({ status: row.status, error: row.error, exit })
      return {
        executionID: row.execution_id,
        sessionID: executions.get(row.execution_id)!.session_id,
        callIndex: row.call_index,
        tool: row.tool,
        status: row.status,
        exit,
        classification,
        outputSignature: taxonomy.normalize(row.error ?? output.output ?? ""),
      }
    })
  const nonzero = nested.filter((row) => row.exit !== null && row.exit !== 0)
  const journalCategories = [
    ...groupBy(
      nested.filter((row) => row.classification.category !== "Completed"),
      (row) => row.classification.category,
    ),
  ]
    .map(([category, rows]) => ({
      category,
      occurrences: rows.length,
      sessions: sessionsOf(rows),
      holdoutSessions: sessionsOf(rows.filter((row) => holdout.has(row.sessionID))),
      sources: count(rows, (row) => row.classification.source),
      tools: count(rows, (row) => row.tool).slice(0, EXAMPLE_LIMIT),
      examples: rows
        .slice(0, EXAMPLE_LIMIT)
        .map((row) => ({ sessionID: row.sessionID, executionID: row.executionID, callIndex: row.callIndex })),
    }))
    .sort((a, b) => b.sessions - a.sessions || b.occurrences - a.occurrences || compareString(a.category, b.category))

  // Cohorts: only dimensions the persisted rows actually carry.
  const cohortTable = (dimension: string, key: (call: Call) => string) =>
    [...groupBy(ordered, key)]
      .map(([value, rows]) => {
        const admitted = rows.filter((call) => call.admitted)
        const decided = admitted.filter((call) => call.completion === "saved" || call.failure !== undefined)
        const own = episodes.filter((episode) => key(episode.initialCall) === value)
        const ownDecided = own.filter((episode) => episode.outcome !== "unknown")
        return {
          dimension,
          value,
          sessions: sessionsOf(rows),
          calls: rows.length,
          refusalRate: stats.proportion(rows.length - admitted.length, rows.length),
          failedCompletionRate: stats.proportion(
            decided.filter((call) => call.failure !== undefined).length,
            decided.length,
          ),
          unknownCompletions: admitted.filter((call) => call.completion === "unknown").length,
          episodes: own.length,
          episodeRecoveryRate: stats.proportion(
            own.filter((episode) => episode.outcome === "recovered").length,
            ownDecided.length,
          ),
        }
      })
      .sort((a, b) => b.calls - a.calls || compareString(a.value, b.value))
      .slice(0, COHORT_VALUE_LIMIT)
  const cohorts = [
    ...cohortTable("version", (call) => call.version),
    ...cohortTable("mode", (call) => call.mode),
    ...cohortTable("provider", (call) => call.providerID ?? "(unknown)"),
    ...cohortTable("model", (call) => (call.providerID ?? "(unknown)") + "/" + (call.modelID ?? "(unknown)")),
    ...cohortTable("session", (call) => (call.child ? "child" : "top-level")),
    ...cohortTable("split", (call) => (holdout.has(call.sessionID) ? "holdout" : "training")),
  ]
  const toolCohorts = [...groupBy(nested, (row) => row.tool)]
    .map(([tool, rows]) => ({
      dimension: "journalTool",
      value: tool,
      calls: rows.length,
      sessions: sessionsOf(rows),
      failureRate: stats.proportion(rows.filter((row) => row.status === "failed").length, rows.length),
      exitCoverage: rows.filter((row) => row.exit !== null).length,
      nonzeroExitRate: stats.proportion(
        rows.filter((row) => row.exit !== null && row.exit !== 0).length,
        rows.filter((row) => row.exit !== null).length,
      ),
    }))
    .sort((a, b) => b.calls - a.calls || compareString(a.value, b.value))
    .slice(0, COHORT_VALUE_LIMIT)

  // Sequences over typed tool events: adjacent tool pairs and episode category transitions.
  const bigrams = [...groupBy(orderedTools, (tool) => tool.sessionID)].flatMap(([, rows]) =>
    rows
      .slice(1)
      .map((tool, position) => ({ sessionID: tool.sessionID, pair: rows[position]!.name + " -> " + tool.name })),
  )
  const transitions = episodes.flatMap((episode) =>
    episode.categories.slice(1).map((category, position) => ({
      sessionID: episode.sessionID,
      pair: episode.categories[position]! + " -> " + category,
    })),
  )
  const sequenceTable = (rows: ReadonlyArray<{ sessionID: string; pair: string }>) =>
    [...groupBy(rows, (row) => row.pair)]
      .map(([pair, group]) => ({ pair, occurrences: group.length, sessions: sessionsOf(group) }))
      .sort((a, b) => b.sessions - a.sessions || b.occurrences - a.occurrences || compareString(a.pair, b.pair))
      .slice(0, SEQUENCE_LIMIT)

  // Effect sizes only between cohorts with published support; the data is observational.
  const cohortFor = (name: string, rows: ReadonlyArray<Call>, hit: (call: Call) => boolean) => ({
    name,
    sessions: sessionsOf(rows),
    events: rows.length,
    hits: rows.filter(hit).length,
  })
  const episodeCohort = (name: string, rows: ReadonlyArray<Episode>) => {
    const decided = rows.filter((episode) => episode.outcome !== "unknown")
    return {
      name,
      sessions: sessionsOf(rows),
      events: decided.length,
      hits: decided.filter((episode) => episode.outcome === "unrecovered").length,
    }
  }
  const children = ordered.filter((call) => call.child)
  const topLevel = ordered.filter((call) => !call.child)
  const refusedCall = (call: Call) => !call.admitted
  const effects = [
    stats.effect(
      "refusal rate per execute call",
      cohortFor("child", children, refusedCall),
      cohortFor("top-level", topLevel, refusedCall),
    ),
    stats.effect(
      "refusal rate per execute call",
      cohortFor(
        "holdout",
        ordered.filter((call) => holdout.has(call.sessionID)),
        refusedCall,
      ),
      cohortFor(
        "training",
        ordered.filter((call) => !holdout.has(call.sessionID)),
        refusedCall,
      ),
    ),
    stats.effect(
      "unrecovered rate per decided episode",
      episodeCohort(
        "child",
        episodes.filter((episode) => episode.child),
      ),
      episodeCohort(
        "top-level",
        episodes.filter((episode) => !episode.child),
      ),
    ),
  ]

  // Review-candidate ranking from published inputs only. It orders what to look at, nothing more.
  const candidates = [
    ...refusals.map((row) => ({ kind: "refusal", row })),
    ...failures.map((row) => ({ kind: "failure", row })),
    ...journalCategories.map((row) => ({ kind: "journal", row: { ...row, episodes: episodeTable([]) } })),
  ]
    .map(({ kind, row }) => {
      const sourceWeight = (name: string) =>
        name === "structured-kind" || name === "structured-type" ? 1 : name === "rule" ? 0.5 : 0
      const decided =
        row.episodes.episodes - (row.episodes.outcomes.find((item) => item.name === "unknown")?.count ?? 0)
      const unrecovered = row.episodes.outcomes.find((item) => item.name === "unrecovered")?.count ?? 0
      const components = {
        sessionShare: stats.round(terminal.length === 0 ? 0 : row.sessions / terminal.length),
        holdoutShare: stats.round(holdout.size === 0 ? 0 : row.holdoutSessions / holdout.size),
        unrecoveredRate: stats.round(decided === 0 ? 0 : unrecovered / decided),
        evidenceQuality: stats.round(
          row.sources.reduce((total, item) => total + sourceWeight(item.name) * item.count, 0) / row.occurrences,
        ),
      }
      return {
        kind,
        category: row.category,
        score: stats.score(components),
        components,
        affectedSessions: row.sessions,
        occurrences: row.occurrences,
        holdoutSessions: row.holdoutSessions,
        decidedEpisodes: decided,
        unrecoveredEpisodes: unrecovered,
      }
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.affectedSessions - a.affectedSessions ||
        b.occurrences - a.occurrences ||
        compareString(a.kind, b.kind) ||
        compareString(a.category, b.category),
    )

  // Data quality: join coverage, duplicates, and states the schema should make impossible.
  const callExecutionIDs = ordered.flatMap((call) => (call.executionID ? [call.executionID] : []))
  const callExecutionIDSet = new Set(callExecutionIDs)
  const scopedExecutionIDs = new Set(scopedExecutions.map((execution) => execution.id))
  const scopedNotifications = notificationRows.filter((row) => terminalIDs.has(row.sessionID))
  const quality = {
    integrity: {
      executeCallsWithDuplicateExecutionID: evidence(duplicates(callExecutionIDs)),
      executionRowsWithDuplicateID: evidence(duplicates(scopedExecutions.map((execution) => execution.id))),
      completionNotificationsWithDuplicateExecutionID: evidence(
        duplicates(scopedNotifications.map((row) => row.executionID)),
      ),
      duplicateMessageSequence: evidence(
        duplicates(messageRows.map((message) => message.session_id + " #" + message.seq)),
      ),
      executionSessionMismatches: evidence(
        scopedExecutions
          .filter((execution) => {
            const call = callByExecution.get(execution.id)
            return call !== undefined && call.sessionID !== execution.session_id
          })
          .map((execution) => execution.id),
      ),
      journalRowsMissingExecution: evidence(
        journalRows
          .filter((row) => !executions.has(row.execution_id))
          .map((row) => ({ executionID: row.execution_id, callIndex: row.call_index })),
      ),
    },
    impossibleStates: {
      terminalSessionsWithoutOutcome: evidence(
        terminal.filter((session) => session.idle_outcome === null).map((session) => session.id),
      ),
      executionsStillRunningInTerminalSessions: evidence(
        scopedExecutions
          .filter((execution) => execution.status === "running" || execution.status === "scheduled")
          .map((execution) => execution.id),
      ),
      executionsCompletedBeforeCreated: evidence(
        scopedExecutions
          .filter((execution) => execution.time_completed !== null && execution.time_completed < execution.time_created)
          .map((execution) => execution.id),
      ),
      notificationStateConflicts: evidence(
        scopedNotifications
          .filter((row) => {
            const execution = executions.get(row.executionID)
            if (!execution) return false
            return (execution.status === "saved") !== (row.state === "completed")
          })
          .map((row) => row.executionID),
      ),
      toolRecordsWithUnknownStatus: evidence(orderedTools.filter((tool) => tool.status === "unknown").map(provenance)),
      shellCallsWithoutExitCode: evidence(
        nested
          .filter(
            (row) => (row.tool === "shell" || row.tool === "bash") && row.status === "completed" && row.exit === null,
          )
          .map((row) => ({ sessionID: row.sessionID, executionID: row.executionID, callIndex: row.callIndex })),
      ),
    },
    coverage: {
      executionIDSources: count(ordered, (call) => call.executionIDSource),
      completionSources: count(
        ordered.filter((call) => call.admitted),
        (call) => call.completionSource,
      ),
      executeCallsMissingExecutionRow: evidence(
        uniqueSorted([...callExecutionIDSet].filter((id) => !scopedExecutionIDs.has(id))),
      ),
      executionRowsMissingExecuteCall: evidence(
        uniqueSorted([...scopedExecutionIDs].filter((id) => !callExecutionIDSet.has(id))),
      ),
      completionNotificationsMissingExecuteCall: evidence(
        uniqueSorted(
          scopedNotifications.filter((row) => !callExecutionIDSet.has(row.executionID)).map((row) => row.executionID),
        ),
      ),
      assistantMessagesWithoutModel: evidence(assistantWithoutModel),
      executeCallsWithModel: ordered.filter((call) => call.providerID !== null).length,
      executionsWithDuration: ordered.filter((call) => call.durationMs !== null).length,
      sessionsWithCost: terminal.filter((session) => (session.cost ?? 0) > 0).length,
      terminalFailuresWithError: terminal.filter(
        (session) => session.idle_outcome === "failed" && session.idle_error_type != null,
      ).length,
      classificationSources: {
        refusals: count(refused, (call) => call.refusal!.source),
        failures: count(failed, (call) => call.failure!.source),
        journal: count(nested, (row) => row.classification.source),
      },
    },
  }

  const strata = [...groupBy(ordered, (call) => call.version + "\0" + call.mode)]
    .map(([key, rows]) => ({
      version: key.split("\0")[0]!,
      mode: rows[0]!.mode,
      calls: rows.length,
      sessions: sessionsOf(rows),
      refused: rows.filter((call) => !call.admitted).length,
      completions: count(rows, (call) => call.completion),
      completionSources: count(rows, (call) => call.completionSource),
    }))
    .sort((a, b) => b.calls - a.calls || compareString(a.version, b.version) || compareString(a.mode, b.mode))

  return {
    manifest: {
      schema: SCHEMA,
      analyzerVersion: VERSION,
      ...(options.snapshot ? { snapshot: options.snapshot } : {}),
      ...(input.queries ? { queries: input.queries } : {}),
      options: { holdout: holdoutSize },
      thresholds: {
        followupCalls: FOLLOWUP_CALLS,
        refusalLoopMinimum: REFUSAL_LOOP_MINIMUM,
        signatureLimit: SIGNATURE_LIMIT,
        exampleLimit: EXAMPLE_LIMIT,
        episodeExampleLimit: EPISODE_EXAMPLE_LIMIT,
        sequenceLimit: SEQUENCE_LIMIT,
        cohortValueLimit: COHORT_VALUE_LIMIT,
        codePreviewLength: CODE_PREVIEW_LENGTH,
        ...stats.constants,
      },
      definitions: {
        holdout: "The newest terminal sessions by time_created (ties by id descending), up to options.holdout.",
        admission:
          "An execute tool record with status completed. On asynchronous versions this proves only that the program was admitted.",
        completion:
          "Decided by the first available source in order: codemode_execution row, completion notification (current failed or legacy error both mean failed), lifecycle metadata on the tool record, the tool record itself for synchronous versions; otherwise unknown.",
        episode:
          "Starts at a refused execute call or an admitted execution that did not save, includes every following execute call in the session, and closes at the first call whose execution saved (recovered), after followupCalls further calls without a save (unrecovered, or unknown when a completion was unknown), or at session end.",
        retryRelation:
          "Each call in an episode is compared with the call before it: exact (identical source), normalized (identical after whitespace collapse), fingerprint (identical sorted static tool paths and top-level declared names), otherwise different.",
        ranking: "Orders review candidates by the published weighted components; it does not produce guidance.",
      },
      taxonomy: taxonomy.published,
      ranking: { weights: stats.rankingWeights, tieBreakers: stats.rankingTieBreakers },
      sessions: sessionRows.length,
      terminalSessions: terminal.length,
      holdoutSessions: holdout.size,
      executeCalls: ordered.length,
      executions: executionRows.length,
      journalRows: journalRows.length,
    },
    events: {
      total: events.length,
      byType: count(events, (event) => event.type),
      sessions: sessionsOf(events),
      example:
        eventExampleSession === undefined
          ? null
          : {
              sessionID: eventExampleSession,
              events: events
                .filter((event) => event.sessionID === eventExampleSession)
                .slice(0, EVENT_EXAMPLE_LIMIT)
                .map((event) => ({
                  seq: event.seq,
                  index: event.index,
                  type: event.type,
                  ...(event.ref ? { ref: event.ref } : {}),
                })),
            },
    },
    strata,
    execute: {
      admission: count(ordered, (call) => (call.admitted ? "admitted" : "refused")),
      completion: count(
        ordered.filter((call) => call.admitted),
        (call) => call.completion,
      ),
      refusals,
      failures,
      refusalLoops,
    },
    episodes: {
      ...episodeTable(episodes),
      byOutcomeAndClosure: count(episodes, (episode) => episode.outcome + " / " + episode.closedBy),
      byInitialKind: count(episodes, (episode) => episode.initial.kind),
      examples: episodes
        .toSorted((a, b) => b.calls - a.calls || byProvenance(a.initial, b.initial))
        .slice(0, EPISODE_EXAMPLE_LIMIT)
        .map((episode) => ({
          sessionID: episode.sessionID,
          initial: episode.initial,
          calls: episode.calls,
          retries: episode.retries,
          categories: episode.categories,
          outcome: episode.outcome,
          closedBy: episode.closedBy,
          recoveryGap: episode.recoveryGap,
          holdout: episode.holdout,
        })),
    },
    sequences: {
      toolBigrams: sequenceTable(bigrams),
      toolStatus: [...groupBy(orderedTools, (tool) => tool.name)]
        .map(([name, rows]) => ({ tool: name, calls: rows.length, statuses: count(rows, (tool) => tool.status) }))
        .sort((a, b) => b.calls - a.calls || compareString(a.tool, b.tool))
        .slice(0, SEQUENCE_LIMIT),
      episodeTransitions: sequenceTable(transitions),
    },
    cohorts: [...cohorts, ...toolCohorts],
    statistics: {
      executionDurationMs: stats.quantiles(
        ordered.flatMap((call) => (call.durationMs === null ? [] : [call.durationMs])),
      ),
      executeCallsPerSession: stats.quantiles([...bySession.values()].map((rows) => rows.length)),
      effects,
    },
    ranking: candidates,
    nested: {
      calls: nested.length,
      byStatus: count(nested, (row) => row.status),
      exits: count(
        nested.filter((row) => row.exit !== null),
        (row) => String(row.exit),
      ),
      categories: journalCategories.slice(0, SIGNATURE_LIMIT),
      recurringNonzero: [...groupBy(nonzero, (row) => row.exit + "\0" + row.outputSignature)]
        .map(([, rows]) => ({
          exit: rows[0]!.exit,
          signature: rows[0]!.outputSignature,
          occurrences: rows.length,
          sessions: sessionsOf(rows),
          holdoutSessions: sessionsOf(rows.filter((row) => holdout.has(row.sessionID))),
          examples: rows
            .slice(0, EXAMPLE_LIMIT)
            .map((row) => ({ sessionID: row.sessionID, executionID: row.executionID, callIndex: row.callIndex })),
        }))
        .sort(
          (a, b) =>
            b.sessions - a.sessions ||
            b.occurrences - a.occurrences ||
            (a.exit ?? 0) - (b.exit ?? 0) ||
            compareString(a.signature, b.signature),
        )
        .slice(0, SIGNATURE_LIMIT),
    },
    terminalFailures: terminal
      .filter((session) => session.idle_outcome === "failed")
      .map((session) => ({
        sessionID: session.id,
        parentID: session.parent_id,
        version: session.version,
        errorType: session.idle_error_type ?? null,
        errorMessage: session.idle_error_message ?? null,
        holdout: holdout.has(session.id),
      })),
    quality,
  }
}

export type Report = ReturnType<typeof analyze>
