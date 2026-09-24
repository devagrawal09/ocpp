import { describe, expect, test } from "bun:test"
import path from "path"
import { CodeModeDiagnostics } from "@ocpp/core/codemode/diagnostics"
import { CodeModeDiagnosticsTaxonomy } from "@ocpp/core/codemode/diagnostics-taxonomy"
import { CodeModeExecutionTable, CodeModeJournalTable } from "@ocpp/core/codemode/sql"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { Project } from "@ocpp/core/project"
import { ProjectTable } from "@ocpp/core/project/sql"
import { AbsolutePath } from "@ocpp/core/schema"
import { SessionMessageTable, SessionTable } from "@ocpp/core/session/sql"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Global } from "@ocpp/util/global"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { input } from "./fixture/codemode-diagnostics"
import { tempGlobalLayer } from "./fixture/global"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))
const report = CodeModeDiagnostics.analyze(input, { holdout: 1 })

/** Inserts the fixture through the real tables, so the loader is exercised against the schema. */
const seed = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
  yield* db.insert(SessionTable).values(
    input.sessions.map((session) => ({
      id: session.id as never,
      project_id: Project.ID.global,
      parent_id: session.parent_id as never,
      slug: session.id,
      directory: AbsolutePath.make("/project"),
      version: session.version,
      cost: session.cost,
      time_created: session.time_created,
      time_updated: session.time_created,
      time_idle: session.time_idle,
      idle_outcome: session.idle_outcome as never,
      idle_error_type: "idle_error_type" in session ? session.idle_error_type : null,
      idle_error_message: "idle_error_message" in session ? session.idle_error_message : null,
    })),
  )
  yield* db.insert(SessionMessageTable).values(
    input.messages.map((message) => ({
      id: message.id as never,
      session_id: message.session_id as never,
      type: message.type as "assistant" | "synthetic",
      seq: message.seq,
      time_created: message.seq,
      data: message.data as never,
    })),
  )
  yield* db.insert(CodeModeExecutionTable).values(
    input.executions.map((execution) => ({
      ...execution,
      session_id: execution.session_id as never,
      assistant_message_id: execution.assistant_message_id as never,
      program: { version: 1, source: "", body: { type: "Program", body: [] }, declarations: [] } as never,
      ir_version: 1,
      snapshot: [],
      time_created: execution.time_created,
      time_updated: execution.time_created,
    })),
  )
  yield* db
    .insert(CodeModeJournalTable)
    .values(input.journal.map((row) => ({ ...row, input: {}, time_created: 1, time_updated: 1 })))
})

/** A small deterministic generator, so shuffled inputs are reproducible across runs. */
const shuffle = <T>(values: ReadonlyArray<T>, seed: number) => {
  let state = seed
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
  const copy = [...values]
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(next() * (index + 1))
    ;[copy[index], copy[other]] = [copy[other]!, copy[index]!]
  }
  return copy
}

describe("CodeModeDiagnosticsTaxonomy", () => {
  test("classifies structured fields first, then published rules, and otherwise leaves records unclassified", () => {
    const classify = CodeModeDiagnosticsTaxonomy.classifyRefusal
    expect(classify({ kind: "ConcurrencyLimit", error: "At most 10 executions may run per Session." })).toMatchObject({
      category: "ConcurrencyLimit",
      source: "structured-kind",
    })
    expect(classify({ error: { type: "provider.transport", message: "ECONNRESET" } })).toMatchObject({
      category: "Provider",
      source: "structured-type",
      structured: "provider.transport",
    })
    expect(classify({ error: { type: "aborted", message: "Tool execution interrupted" } })).toMatchObject({
      category: "Interrupted",
      source: "structured-type",
    })
    expect(
      classify({ error: '{"type":"tool.execution","message":"Regular expressions are not available; x"}' }),
    ).toMatchObject({
      category: "UnsupportedSyntax",
      source: "rule",
      rule: "regex",
      signature: "regular expressions are not available; x",
    })
    expect(classify({ error: { type: "tool.execution", message: "Something new happened" } })).toEqual({
      category: "unclassified",
      source: "unclassified",
      signature: "something new happened",
    })
  })

  test("recovers the inner kind of the legacy synchronous wrapper without trusting the rest of its text", () => {
    const classification = CodeModeDiagnosticsTaxonomy.classifyFailure({
      error:
        'Execution exe_1 failed (12 durable bytes).\nBEGIN\n{ "ok": false, "error": { "kind": "TimeoutExceeded" } }',
    })
    expect(classification).toMatchObject({ category: "Legacy:TimeoutExceeded", source: "rule", rule: "legacy-wrapper" })
    expect(CodeModeDiagnosticsTaxonomy.classifyFailure({ kind: "CommitFailure", error: "anything" })).toMatchObject({
      category: "CommitFailure",
      source: "structured-kind",
    })
    // A notification-only failure has state but no text: that is a recorded fact, not a guess.
    expect(CodeModeDiagnosticsTaxonomy.classifyFailure({ error: "" })).toEqual({
      category: "NoErrorRecorded",
      source: "unclassified",
      signature: "",
    })
    expect(
      CodeModeDiagnosticsTaxonomy.classifyRefusal({
        error: "Code Mode allows at most 4 concurrent executions per Session.",
      }),
    ).toMatchObject({
      category: "ConcurrencyLimit",
      rule: "concurrency-limit",
    })
    expect(CodeModeDiagnosticsTaxonomy.classifyJournal({ status: "completed", exit: 127, error: null })).toMatchObject({
      category: "NonzeroExit",
      structured: "exit 127",
    })
    expect(
      CodeModeDiagnosticsTaxonomy.classifyJournal({ status: "failed", exit: null, error: "File not found: /a" }),
    ).toMatchObject({
      category: "NotFound",
      rule: "file-not-found",
    })
  })

  test("fingerprints programs by static tool paths and declared names only", () => {
    const fingerprint = CodeModeDiagnosticsTaxonomy.fingerprint
    expect(fingerprint("const a = tools.fs.read({ path: 'x' })\nreturn tools.shell({ command: 'ls' })")).toBe(
      "tools.fs.read,tools.shell|a",
    )
    expect(fingerprint("return tools.shell({ command: 'pwd' })\nconst a = tools.fs.read({ path: 'y' })")).toBe(
      "tools.fs.read,tools.shell|a",
    )
    expect(fingerprint("let x = 1")).toBe("|")
    expect(CodeModeDiagnosticsTaxonomy.normalizedSource("return  tools.shell({ command: 'true' })\n")).toBe(
      "return tools.shell({ command: 'true' })",
    )
  })

  test("publishes every rule as data", () => {
    expect(CodeModeDiagnosticsTaxonomy.published.refusalRules.map((rule) => rule.name)).toContain("concurrency-limit")
    expect(CodeModeDiagnosticsTaxonomy.published.failureRules.every((rule) => typeof rule.pattern === "string")).toBe(
      true,
    )
  })
})

describe("CodeModeDiagnostics", () => {
  test("keeps admission and completion separate and stratifies by version and mode", () => {
    expect(report.manifest).toMatchObject({
      schema: "ocpp.codemode-diagnostics/4",
      terminalSessions: 3,
      holdoutSessions: 1,
      executeCalls: 11,
      options: { holdout: 1 },
      thresholds: { followupCalls: 5, refusalLoopMinimum: 3, minCohortSessions: 20 },
    })
    expect(report.strata.map((row) => [row.version, row.mode, row.calls, row.refused])).toEqual([
      ["1.1.0", "unknown", 6, 6],
      ["1.0.0", "unknown", 2, 1],
      ["1.1.0", "async", 2, 0],
      ["1.0.0", "sync", 1, 0],
    ])
    expect(report.execute.admission).toEqual([
      { name: "refused", count: 7 },
      { name: "admitted", count: 4 },
    ])
    expect(report.execute.completion).toEqual([
      { name: "failed", count: 2 },
      { name: "saved", count: 2 },
    ])
    expect(report.quality.coverage.executionIDSources).toEqual([
      { name: "none", count: 8 },
      { name: "metadata", count: 3 },
    ])
  })

  test("reports classification sources per category rather than a single signature", () => {
    const category = (name: string) => report.execute.refusals.find((row) => row.category === name)
    expect(category("ConcurrencyLimit")).toMatchObject({
      occurrences: 3,
      sessions: 1,
      sources: [{ name: "structured-kind", count: 3 }],
    })
    // Asymmetric matchers inside toMatchObject rewrite the matched array in place, and the report
    // is shared across tests, so the examples are asserted directly.
    expect(category("ConcurrencyLimit")?.examples).toHaveLength(3)
    expect(category("ConcurrencyLimit")?.examples[0]).toEqual({
      sessionID: "ses_new",
      messageID: "msg_new_3",
      seq: 3,
      index: 0,
    })
    expect(category("UnsupportedSyntax")).toMatchObject({
      sources: [{ name: "rule", count: 1 }],
      rules: [{ name: "regex", count: 1 }],
    })
    expect(category("Provider")).toMatchObject({ sources: [{ name: "structured-type", count: 1 }] })
    expect(category("unclassified")).toMatchObject({ occurrences: 1, sessions: 1 })
    expect(category("ParseError")).toMatchObject({ rules: [{ name: "parse", count: 1 }] })
    expect(report.execute.failures.map((row) => [row.category, row.sources[0]!.name])).toEqual([
      ["Legacy:ToolFailure", "rule"],
      ["ToolFailure", "structured-kind"],
    ])
    expect(report.execute.refusalLoops).toHaveLength(0)
  })

  test("builds failure episodes with retry relations and bounded recovery", () => {
    expect(report.episodes).toMatchObject({
      episodes: 4,
      sessions: 3,
      outcomes: [
        { name: "unrecovered", count: 3 },
        { name: "recovered", count: 1 },
      ],
      byOutcomeAndClosure: [
        { name: "unrecovered / session-end", count: 3 },
        { name: "recovered / saved", count: 1 },
      ],
      retries: { exact: 0, normalized: 2, fingerprint: 0, different: 4 },
    })
    const recovered = report.episodes.examples.find((episode) => episode.outcome === "recovered")
    expect(recovered).toEqual({
      sessionID: "ses_new",
      initial: {
        sessionID: "ses_new",
        messageID: "msg_new_1",
        seq: 1,
        index: 1,
        executionID: "exe_new_1",
        kind: "failure",
        category: "ToolFailure",
        source: "structured-kind",
      },
      calls: 5,
      // c3 -> refusal (different), refusal -> refusal with extra whitespace (normalized) twice, then the saving program (different).
      retries: { exact: 0, normalized: 2, fingerprint: 0, different: 2 },
      categories: ["ToolFailure", "ConcurrencyLimit", "ConcurrencyLimit", "ConcurrencyLimit"],
      outcome: "recovered",
      closedBy: "saved",
      recoveryGap: 4,
      holdout: false,
    })
    expect(report.sequences.episodeTransitions).toEqual([
      { pair: "ConcurrencyLimit -> ConcurrencyLimit", occurrences: 2, sessions: 1 },
      { pair: "ParseError -> Legacy:ToolFailure", occurrences: 1, sessions: 1 },
      { pair: "ToolFailure -> ConcurrencyLimit", occurrences: 1, sessions: 1 },
      { pair: "UnsupportedSyntax -> Provider", occurrences: 1, sessions: 1 },
    ])
    expect(report.sequences.toolBigrams[0]).toEqual({ pair: "execute -> execute", occurrences: 8, sessions: 2 })
  })

  test("cohorts, ranking, and statistics use only published inputs and report support honestly", () => {
    const sessionCohorts = report.cohorts.filter((row) => row.dimension === "session")
    expect(sessionCohorts.map((row) => [row.value, row.calls, row.sessions])).toEqual([
      ["top-level", 10, 2],
      ["child", 1, 1],
    ])
    expect(report.cohorts.find((row) => row.dimension === "provider" && row.value === "q")).toMatchObject({
      calls: 1,
      episodes: 1,
    })
    expect(report.cohorts.find((row) => row.dimension === "journalTool" && row.value === "shell")).toMatchObject({
      calls: 2,
      exitCoverage: 2,
      nonzeroExitRate: { numerator: 1, denominator: 2, rate: 0.5 },
    })
    // The lone unclassified refusal ranks first: it is the only holdout session and never recovered,
    // and the low evidence quality is visible in its components rather than hidden.
    expect(report.ranking[0]).toMatchObject({
      kind: "refusal",
      category: "unclassified",
      score: 0.5667,
      components: { sessionShare: 0.3333, holdoutShare: 1, unrecoveredRate: 1, evidenceQuality: 0 },
    })
    expect(report.ranking.find((row) => row.category === "ConcurrencyLimit")).toMatchObject({
      components: { sessionShare: 0.3333, holdoutShare: 0, unrecoveredRate: 0, evidenceQuality: 1 },
    })
    expect(report.ranking.map((row) => row.score)).toEqual(
      report.ranking.map((row) => row.score).toSorted((a, b) => b - a),
    )
    expect(
      report.ranking.every(
        (row) =>
          Math.abs(
            row.score -
              (0.35 * row.components.sessionShare +
                0.25 * row.components.holdoutShare +
                0.2 * row.components.unrecoveredRate +
                0.2 * row.components.evidenceQuality),
          ) < 0.001,
      ),
    ).toBe(true)
    // Three sessions cannot support an effect size; the comparison is reported but marked unsupported.
    expect(report.statistics.effects.every((effect) => effect.supported === false && effect.observational)).toBe(true)
    expect(report.statistics.executionDurationMs).toEqual({ count: 2, min: 1, p50: 1, p90: 1, max: 1, mean: 1 })
  })

  test("flags impossible states and reports coverage with provenance", () => {
    expect(report.quality.impossibleStates.notificationStateConflicts).toEqual({ count: 0, examples: [] })
    expect(report.quality.coverage).toMatchObject({
      completionSources: [
        { name: "execution", count: 2 },
        { name: "tool", count: 2 },
      ],
      sessionsWithCost: 1,
      terminalFailuresWithError: 1,
      executeCallsWithModel: 11,
      classificationSources: {
        journal: [
          { name: "structured-type", count: 2 },
          { name: "rule", count: 1 },
        ],
      },
    })
    expect(report.nested.categories.map((row) => row.category)).toEqual(["NonzeroExit", "NotFound"])
    expect(report.terminalFailures).toEqual([
      {
        sessionID: "ses_failed",
        parentID: "ses_new",
        version: "1.1.0",
        errorType: "provider.transport",
        errorMessage: "socket closed",
        holdout: true,
      },
    ])
  })

  test("is byte-identical across repeated runs and any input row order", () => {
    const bytes = CodeModeDiagnostics.stringify(report)
    expect(CodeModeDiagnostics.stringify(CodeModeDiagnostics.analyze(input, { holdout: 1 }))).toBe(bytes)
    for (const seed of [1, 7, 42]) {
      const shuffled = CodeModeDiagnostics.analyze(
        {
          sessions: shuffle(input.sessions, seed),
          messages: shuffle(input.messages, seed + 1),
          executions: shuffle(input.executions, seed + 2),
          journal: shuffle(input.journal, seed + 3),
        },
        { holdout: 1 },
      )
      expect(CodeModeDiagnostics.stringify(shuffled)).toBe(bytes)
    }
    expect(bytes).not.toContain("generatedAt")
  })

  test("recognizes the legacy error notification state and leaves unknown states unknown", () => {
    const withState = (state: string) =>
      CodeModeDiagnostics.analyze(
        {
          ...input,
          executions: input.executions.filter((execution) => execution.id !== "exe_new_1"),
          messages: input.messages.map((message) =>
            message.id === "msg_new_2"
              ? {
                  ...message,
                  data: {
                    ...message.data,
                    metadata: { source: "codemode", executionID: "exe_new_1", state },
                  },
                }
              : message,
          ),
        },
        { holdout: 1 },
      )

    const legacy = withState("error").execute.completion
    const unknown = withState("unexpected").execute.completion
    expect(legacy.find((row) => row.name === "failed")?.count ?? 0).toBe(
      (unknown.find((row) => row.name === "failed")?.count ?? 0) + 1,
    )
    expect(unknown).toContainEqual({ name: "unknown", count: 1 })
  })

  test("matches the golden report for the shared fixture", async () => {
    const golden = await Bun.file(path.join(import.meta.dirname, "fixture/codemode-diagnostics.golden.json")).text()
    expect(CodeModeDiagnostics.stringify(report) + "\n").toBe(golden)
  })

  it.effect("loads the same shapes from a real database through the published queries", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* seed
      const loaded = yield* CodeModeDiagnostics.load((text) => db.all(sql.raw(text)).pipe(Effect.orDie))
      const fromDatabase = CodeModeDiagnostics.analyze(loaded, { holdout: 1 })
      expect(fromDatabase.manifest.queries).toMatchObject({ sessions: expect.stringContaining("idle_error_type") })
      const { queries: _queries, ...manifest } = fromDatabase.manifest
      expect(CodeModeDiagnostics.stringify({ ...fromDatabase, manifest })).toBe(CodeModeDiagnostics.stringify(report))
    }),
  )

  test("the command produces identical bytes twice and refuses a snapshot with a pending write-ahead log", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "snapshot.db")
    await Effect.runPromise(
      seed.pipe(
        Effect.scoped,
        Effect.provide(AppNodeBuilder.build(Database.configured({ path: file }), [[Global.node, tempGlobalLayer]])),
      ),
    )
    const run = async (...extra: string[]) => {
      const child = Bun.spawn(["bun", "run", "script/session-diagnostics.ts", file, "--holdout", "1", ...extra], {
        cwd: path.resolve(import.meta.dirname, ".."),
        stdout: "pipe",
        stderr: "pipe",
      })
      return {
        exit: await child.exited,
        stdout: await new Response(child.stdout).text(),
        stderr: await new Response(child.stderr).text(),
      }
    }
    const first = await run()
    const second = await run()
    expect(first.exit).toBe(0)
    expect(second.stdout).toBe(first.stdout)
    const parsed = JSON.parse(first.stdout)
    expect(parsed.manifest.snapshot.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed.manifest.terminalSessions).toBe(3)

    await Bun.write(file + "-wal", "pending")
    const refused = await run()
    expect(refused.exit).toBe(2)
    expect(refused.stderr).toContain("non-empty -wal")

    await Bun.file(file + "-wal").delete()
    await Bun.write(file + "-journal", "pending")
    const journalRefused = await run()
    expect(journalRefused.exit).toBe(2)
    expect(journalRefused.stderr).toContain("non-empty -journal")
  })
})
