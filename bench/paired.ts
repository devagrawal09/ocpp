#!/usr/bin/env bun
// Paired-commit benchmark runner. Runs one task manifest under two OC++ commits with the same model,
// each arm/repeat against its own freshly isolated server, and writes runs.jsonl + report.json + report.md.
// See bench/README.md. Reuses the existing headless entry (`run --format json`) — no agent loop here.
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"

export type Task = {
  id: string
  fixture: string
  prompt: string
  toolsKind: string
  scenario: string
  deadlineSec: number
}

export type Arm = "A" | "B"

const SCENARIOS = ["noedit", "pattern", "permission", "grounding", "shrink"]
const BENCH = import.meta.dir
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
/** Only these names may be forwarded, and only to the server process (vendor drivers need them). */
export const CREDENTIALS = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]
const ISOLATION_KEYS = ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR"]
/** Names Config.discover walks upward for; none may exist on the ancestor chain of a task checkout. */
export const CONFIG_TARGETS = [".ocpp", ".claude", ".agents", "ocpp.json", "ocpp.jsonc"]

const within = (root: string, p: string) => p === root || p.startsWith(root + path.sep)

function walkFiles(dir: string): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const p = path.join(dir, name)
      const st = lstatSync(p)
      if (st.isSymbolicLink()) throw new Error(`symlink ${p} is not allowed in fixtures`)
      return st.isDirectory() ? walkFiles(p) : [p]
    })
}

export function validateManifest(input: unknown, fixturesDir = path.join(BENCH, "fixtures")) {
  if (!Array.isArray(input) || input.length === 0) throw new Error("manifest must be a non-empty array")
  const root = realpathSync(fixturesDir)
  const ids = new Set<string>()
  return input.map((raw, i) => {
    const t = raw as Partial<Task>
    const where = `tasks[${i}]`
    if (typeof t.id !== "string" || !SAFE_COMPONENT.test(t.id))
      throw new Error(`${where}.id must be a single safe path component ([A-Za-z0-9_-], at most 64)`)
    if (ids.has(t.id)) throw new Error(`${where}.id ${t.id} is duplicated`)
    ids.add(t.id)
    if (typeof t.prompt !== "string" || !t.prompt.trim()) throw new Error(`${where}.prompt must be non-empty`)
    if (typeof t.fixture !== "string" || !SAFE_COMPONENT.test(t.fixture))
      throw new Error(`${where}.fixture must be a single safe path component`)
    const fixture = path.join(root, t.fixture)
    if (!existsSync(fixture) || !within(root, realpathSync(fixture)) || realpathSync(fixture) === root)
      throw new Error(`${where}.fixture ${t.fixture} does not exist under ${root}`)
    walkFiles(fixture)
    if (typeof t.scenario !== "string" || !SCENARIOS.includes(t.scenario))
      throw new Error(`${where}.scenario must be one of ${SCENARIOS.join(", ")}`)
    if (typeof t.toolsKind !== "string" || !t.toolsKind) throw new Error(`${where}.toolsKind must be a string`)
    if (
      typeof t.deadlineSec !== "number" ||
      !Number.isInteger(t.deadlineSec) ||
      t.deadlineSec < 1 ||
      t.deadlineSec > 7200
    )
      throw new Error(`${where}.deadlineSec must be an integer in [1, 7200]`)
    return t as Task
  })
}

// mulberry32: small deterministic PRNG so order and bootstrap are reproducible from --seed.
export function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle<T>(items: readonly T[], next: () => number) {
  return items.reduce(
    (out, _, i) => {
      const j = i + Math.floor(next() * (out.length - i))
      return out.map((v, k) => (k === i ? out[j] : k === j ? out[i] : v))
    },
    [...items],
  )
}

/** Blocks are (repeat, task) pairs; tasks are interleaved per repeat and AB/BA is randomized per block. */
export function schedule(taskIDs: readonly string[], repeats: number, seed: number) {
  const next = rng(seed)
  return Array.from({ length: repeats }, (_, repeat) => shuffle(taskIDs, next).map((task) => ({ task, repeat })))
    .flat()
    .map((block, index) => ({ ...block, index, order: (next() < 0.5 ? ["A", "B"] : ["B", "A"]) as Arm[] }))
}

/** Fresh HOME/XDG/TMPDIR, task checkout and a distinct loopback port for every (block, arm), all under `work`. */
export function isolation(
  work: string,
  block: { task: string; repeat: number; index: number },
  arm: Arm,
  portBase: number,
) {
  if (!SAFE_COMPONENT.test(block.task)) throw new Error(`unsafe task id ${block.task}`)
  const rel = path.join(block.task, `r${block.repeat}`, arm)
  const dir = path.join(work, rel)
  if (!within(path.resolve(work), path.resolve(dir))) throw new Error(`${dir} escapes ${work}`)
  const dirs = {
    HOME: path.join(dir, "home"),
    XDG_DATA_HOME: path.join(dir, "xdg", "data"),
    XDG_CONFIG_HOME: path.join(dir, "xdg", "config"),
    XDG_CACHE_HOME: path.join(dir, "xdg", "cache"),
    XDG_STATE_HOME: path.join(dir, "xdg", "state"),
    TMPDIR: path.join(dir, "tmp"),
  }
  return {
    rel,
    dir,
    task: path.join(dir, "task"),
    dirs,
    db: path.join(dirs.XDG_DATA_HOME, "ocpp", "ocpp-local.db"),
    port: portBase + block.index * 2 + (arm === "A" ? 0 : 1),
  }
}

/**
 * Server env = base + allowlisted credentials + isolation roots (applied last, so nothing can override them).
 * Task env (client, git, grader, session shell commands) never carries credentials.
 */
export function armEnv(
  dirs: Record<string, string>,
  passEnv: readonly string[],
  source: Record<string, string | undefined>,
) {
  const rejected = passEnv.filter((k) => !CREDENTIALS.includes(k))
  if (rejected.length)
    throw new Error(`--pass-env only accepts ${CREDENTIALS.join(", ")}; rejected ${rejected.join(", ")}`)
  if (ISOLATION_KEYS.some((k) => !dirs[k])) throw new Error("isolation roots are incomplete")
  const roots = Object.fromEntries(ISOLATION_KEYS.map((k) => [k, dirs[k]]))
  const base = { PATH: source.PATH ?? "/usr/bin:/bin", LANG: "en_US.UTF-8", TERM: "dumb", NO_COLOR: "1" }
  const secrets = Object.fromEntries(passEnv.flatMap((k) => (source[k] ? [[k, source[k] as string]] : [])))
  return {
    task: { ...base, ...roots } as Record<string, string>,
    server: { ...base, ...secrets, ...roots } as Record<string, string>,
    secrets: Object.keys(secrets),
  }
}

/** Dependency installs and harness git commands see PATH and the real HOME (bun's package cache) only — never credentials. */
export function installEnv(source: Record<string, string | undefined>) {
  return { PATH: source.PATH ?? "/usr/bin:/bin", HOME: os.homedir(), LANG: "en_US.UTF-8" } as Record<string, string>
}

/** Paths on the ancestor chain of `dir` (exclusive) that config discovery would pick up. */
export function ambientConfig(dir: string) {
  const up = (d: string): string[] => {
    const parent = path.dirname(d)
    return parent === d ? [] : [parent, ...up(parent)]
  }
  return up(path.resolve(dir)).flatMap((d) =>
    CONFIG_TARGETS.filter((t) => existsSync(path.join(d, t))).map((t) => path.join(d, t)),
  )
}

export type Inventory = {
  config: { type: string; path?: string; info?: unknown }[]
  mcp: unknown[]
  plugin: unknown[]
  reference: unknown[]
}

/** The effective configuration must be exactly the generated document, with no MCP servers, plugins or references. */
export function inventoryViolations(inv: Inventory, root: string, expected: { path: string; info: unknown }) {
  const realRoot = existsSync(root) ? realpathSync(root) : root
  const inRoot = (p: string) => within(root, p) || within(realRoot, existsSync(p) ? realpathSync(p) : p)
  const docs = inv.config.filter((e) => e.type === "document")
  return [
    ...inv.config
      .filter((e) => e.path !== undefined && !inRoot(e.path))
      .map((e) => `config source outside isolation: ${e.type} ${e.path}`),
    ...docs
      .filter((d) => d.path !== expected.path || JSON.stringify(d.info) !== JSON.stringify(expected.info))
      .map((d) => `unexpected config document ${d.path}`),
    ...(docs.length === 1 ? [] : [`expected exactly one config document, got ${docs.length}`]),
    ...(inv.mcp.length ? [`MCP servers present: ${inv.mcp.length}`] : []),
    ...(inv.plugin.length ? [`plugins present: ${inv.plugin.length}`] : []),
    ...(inv.reference.length ? [`references present: ${inv.reference.length}`] : []),
  ]
}

export function quantile(sorted: readonly number[], q: number) {
  if (sorted.length === 0) return Number.NaN
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN)

/** Percentile bootstrap of the mean paired difference (B - A). Fewer than two pairs get no interval. */
export function bootstrap(diffs: readonly number[], seed: number, resamples = 2000) {
  if (diffs.length < 2) return { mean: diffs.length ? diffs[0] : Number.NaN, lo: null, hi: null, n: diffs.length }
  const next = rng(seed)
  const means = Array.from({ length: resamples }, () =>
    mean(Array.from({ length: diffs.length }, () => diffs[Math.floor(next() * diffs.length)])),
  ).sort((a, b) => a - b)
  return { mean: mean(diffs), lo: quantile(means, 0.025), hi: quantile(means, 0.975), n: diffs.length }
}

export type Outcome =
  | "ok"
  | "timeout"
  | "server_death"
  | "missing_delivery"
  | "agent_error"
  | "setup_error"
  | "runner_error"

export type CostSource = "sdk_estimate" | "provider" | "unknown" | "none"

export type RunRecord = {
  task: string
  repeat: number
  block: number
  arm: Arm
  position: number
  sha: string
  outcome: Outcome
  /** outcome ok, no invalid artifacts, task success AND conduct pass. */
  success: boolean
  gradeSuccess?: string
  conduct?: string
  invalid: string[]
  wallMs: number
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  cost: number | null
  costSource: CostSource
  usageSource: "db_tree" | "stream" | "none"
  sessions: number
  /** Cache-read tokens on the first model request; later reuse can be created within the run itself. */
  firstCacheRead: number | null
  events: string[]
  sessionID?: string
  archive: string
}

const RELIABILITY: Outcome[] = ["timeout", "server_death", "missing_delivery", "agent_error"]
const totalTokens = (t: RunRecord["tokens"]) => t.input + t.output + t.reasoning

export function summarize(runs: readonly RunRecord[], seed: number) {
  const tasks = [...new Set(runs.map((r) => r.task))]
  return tasks.map((task, ti) => {
    const mine = runs.filter((r) => r.task === task)
    const admitted = mine.filter((r) => r.outcome !== "setup_error")
    const arm = (a: Arm) => {
      const rs = admitted.filter((r) => r.arm === a)
      const rate = (pred: (r: RunRecord) => boolean) => (rs.length ? rs.filter(pred).length / rs.length : Number.NaN)
      const costs = rs.map((r) => r.cost)
      return {
        n: rs.length,
        success: rate((r) => r.success),
        taskSuccess: rate((r) => r.gradeSuccess === "pass"),
        conductPass: rate((r) => r.conduct === "pass"),
        wallMs: mean(rs.map((r) => r.wallMs)),
        tokens: mean(rs.map((r) => totalTokens(r.tokens))),
        cost: costs.some((c) => c === null) ? null : mean(costs as number[]),
        costSources: [...new Set(rs.map((r) => r.costSource))],
        timeouts: rs.filter((r) => r.outcome === "timeout").length,
        reliability: rs.filter((r) => RELIABILITY.includes(r.outcome)).length,
        invalid: rs.filter((r) => r.invalid.length > 0 || r.outcome === "runner_error").length,
        setupErrors: mine.filter((r) => r.arm === a && r.outcome === "setup_error").length,
        events: rs.flatMap((r) => r.events),
        observedFirstRequestCache: {
          hit: rs.filter((r) => (r.firstCacheRead ?? 0) > 0).length,
          miss: rs.filter((r) => r.firstCacheRead === 0).length,
          unknown: rs.filter((r) => r.firstCacheRead === null).length,
        },
      }
    }
    const repeats = [...new Set(admitted.map((r) => r.repeat))].sort((x, y) => x - y)
    const pairs = repeats.flatMap((repeat) => {
      const a = admitted.find((r) => r.repeat === repeat && r.arm === "A")
      const b = admitted.find((r) => r.repeat === repeat && r.arm === "B")
      if (!a || !b) return []
      return [
        {
          repeat,
          order: a.position < b.position ? "AB" : "BA",
          a: { outcome: a.outcome, success: a.success, wallMs: a.wallMs, cost: a.cost, sessionID: a.sessionID },
          b: { outcome: b.outcome, success: b.success, wallMs: b.wallMs, cost: b.cost, sessionID: b.sessionID },
          diff: Number(b.success) - Number(a.success),
          wallDeltaMs: b.wallMs - a.wallMs,
          tokenDelta: totalTokens(b.tokens) - totalTokens(a.tokens),
          costDelta: a.cost === null || b.cost === null ? null : b.cost - a.cost,
        },
      ]
    })
    const costDeltas = pairs.map((p) => p.costDelta)
    return {
      task,
      A: arm("A"),
      B: arm("B"),
      pairedDiff: bootstrap(
        pairs.map((p) => p.diff),
        seed + ti + 1,
      ),
      wallDeltaMs: mean(pairs.map((p) => p.wallDeltaMs)),
      tokenDelta: mean(pairs.map((p) => p.tokenDelta)),
      costDelta: costDeltas.length === 0 || costDeltas.some((c) => c === null) ? null : mean(costDeltas as number[]),
      pairs,
    }
  })
}

const fmt = (x: number | null, d = 2) => (x !== null && Number.isFinite(x) ? x.toFixed(d) : "—")

type ArmSummary = ReturnType<typeof summarize>[number]["A"]

export function markdown(
  meta: { a: string; b: string; shas: Record<Arm, string>; model: string; repeats: number; seed: number },
  summary: ReturnType<typeof summarize>,
) {
  const sources = [...new Set(summary.flatMap((s) => [...s.A.costSources, ...s.B.costSources]))]
  const thin = summary.some((s) => s.pairedDiff.n < 2)
  const ci = (p: ReturnType<typeof bootstrap>) =>
    p.lo === null || p.hi === null ? `${fmt(p.mean)} (no CI, n=${p.n})` : `${fmt(p.mean)} [${fmt(p.lo)}, ${fmt(p.hi)}]`
  const armCell = (a: ArmSummary) => `${fmt(a.success)} (${fmt(a.taskSuccess)}/${fmt(a.conductPass)}) n=${a.n}`
  const counts = (a: ArmSummary) => `${a.timeouts}/${a.reliability}/${a.invalid}/${a.setupErrors}`
  const cacheCell = (a: ArmSummary) =>
    `${a.observedFirstRequestCache.hit}/${a.observedFirstRequestCache.miss}/${a.observedFirstRequestCache.unknown}`
  const events = summary.flatMap((s) => [
    ...s.A.events.map((e) => `- ${s.task} A: ${e}`),
    ...s.B.events.map((e) => `- ${s.task} B: ${e}`),
  ])
  return [
    `# Paired benchmark ${meta.a} (A) vs ${meta.b} (B)`,
    "",
    `model \`${meta.model}\` · repeats ${meta.repeats} · seed ${meta.seed} · success = valid run AND task pass AND conduct pass · diff = B − A`,
    ...(meta.shas.A === meta.shas.B
      ? ["", "**Same-SHA smoke test: A and B are the same commit; any difference is noise.**"]
      : []),
    ...(thin ? ["", "**Descriptive only:** tasks with fewer than 2 complete pairs get no interval."] : []),
    "",
    "| task | pairs | A succ (task/conduct) | B succ (task/conduct) | B−A [95% bootstrap CI] | Δwall s | Δtokens | Δcost $ | A to/rel/inv/setup | B to/rel/inv/setup |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...summary.map(
      (s) =>
        `| ${s.task} | ${s.pairedDiff.n} | ${armCell(s.A)} | ${armCell(s.B)} | ${ci(s.pairedDiff)} | ${fmt(s.wallDeltaMs / 1000, 1)} | ${fmt(s.tokenDelta, 0)} | ${s.costDelta === null ? "unknown" : fmt(s.costDelta, 4)} | ${counts(s.A)} | ${counts(s.B)} |`,
    ),
    "",
    `Cost source: ${sources.join(", ") || "none"}. sdk_estimate = vendor SDK estimate, not billed spend; unknown = no cost reported, so no $ delta. Tokens (input+output+reasoning) and cost sum the whole session tree.`,
    "",
    "## Observed first-request cache reads (hit/miss/unknown; provider caches cannot be reset)",
    ...summary.map((s) => `- ${s.task}: A ${cacheCell(s.A)}, B ${cacheCell(s.B)}`),
    "",
    "## Reliability events",
    ...(events.length ? events : ["- none"]),
    "",
    "to/rel = timeouts / all reliability failures (timeout, server death, missing delivery, agent error), counted as failures. inv = runs with archive, grader or parse failures. setup = excluded from pairs.",
    "",
  ].join("\n")
}

// ---------------------------------------------------------------------------------------------------------------
// Orchestration

function sh(cmd: string[], cwd: string, env: Record<string, string>) {
  const p = Bun.spawnSync(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

function must(cmd: string[], cwd: string, env: Record<string, string>) {
  const r = sh(cmd, cwd, env)
  if (r.code !== 0)
    throw new Error(`${cmd.join(" ")} (cwd ${cwd}) exited ${r.code}: ${(r.err || r.out).slice(0, 2000)}`)
  return r.out.trim()
}

function hashTree(dir: string) {
  const h = createHash("sha256")
  walkFiles(dir).forEach((f) => h.update(path.relative(dir, f) + "\0").update(readFileSync(f)))
  return h.digest("hex")
}

const hashFile = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex")
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

export function parseArgs(argv: string[]) {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const int = (name: string, fallback: number, lo: number, hi: number) => {
    const raw = get(name)
    const n = raw === undefined ? fallback : Number(raw)
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`--${name} must be an integer in [${lo}, ${hi}]`)
    return n
  }
  const a = get("a")
  const b = get("b")
  const model = get("model")
  if (!a || !b || !model)
    throw new Error(
      "usage: bun bench/paired.ts --a <rev> --b <rev> --model <provider/model#variant> [--tasks bench/tasks.json] [--repeats 3] [--out dir] [--resume] [--work dir] [--seed 1] [--only id,id] [--pass-env NAME,NAME] [--subagent-depth 1] [--port-base 18081] [--keep-worktrees]",
    )
  ;[a, b, model].forEach((v) => {
    if (v.startsWith("-")) throw new Error(`option-like value ${v} is not a revision or model`)
  })
  if (!model.includes("/")) throw new Error("--model must look like provider/model#variant")
  const ts = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")
  return {
    a,
    b,
    model,
    tasks: path.resolve(get("tasks") ?? path.join(BENCH, "tasks.json")),
    repeats: int("repeats", 3, 1, 100),
    out: path.resolve(get("out") ?? path.join(BENCH, "out", ts)),
    resume: argv.includes("--resume"),
    work: get("work"),
    seed: int("seed", 1, 0, 2 ** 31 - 1),
    only: get("only")?.split(",").filter(Boolean),
    passEnv: (get("pass-env") ?? "").split(",").filter(Boolean),
    subagentDepth: int("subagent-depth", 1, 0, 8),
    portBase: int("port-base", 18081, 1024, 65000),
    keepWorktrees: argv.includes("--keep-worktrees"),
  }
}

export type RunConfig = Omit<ReturnType<typeof parseArgs>, "work"> & { work: string }

/** Fresh output directories only, unless --resume and the frozen inputs match meta.json exactly. */
export function prepareOut(out: string, resume: boolean, frozen: unknown): RunRecord[] {
  const entries = existsSync(out) ? readdirSync(out) : []
  if (entries.length === 0) {
    mkdirSync(out, { recursive: true })
    return []
  }
  if (!resume) throw new Error(`--out ${out} is not empty; choose a new directory or pass --resume`)
  const metaFile = path.join(out, "meta.json")
  if (!existsSync(metaFile)) throw new Error(`--resume: ${metaFile} is missing`)
  const prior = (JSON.parse(readFileSync(metaFile, "utf8")) as { frozen?: unknown }).frozen
  if (JSON.stringify(prior) !== JSON.stringify(frozen)) throw new Error("--resume: frozen inputs differ from meta.json")
  const runsFile = path.join(out, "runs.jsonl")
  return existsSync(runsFile)
    ? readFileSync(runsFile, "utf8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l) as RunRecord)
    : []
}

async function healthy(port: number) {
  return fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
    .then(async (r) => ({
      status: r.status,
      body: (await r.json()) as { healthy?: boolean; version?: string; pid?: number },
    }))
    .catch(() => undefined)
}

export async function api(port: number, method: string, pathname: string, body?: unknown) {
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`${method} ${pathname} -> ${r.status}: ${text.slice(0, 300)}`)
  return text ? (JSON.parse(text) as unknown) : undefined
}

export const locationQuery = (directory: string) => `location%5Bdirectory%5D=${encodeURIComponent(directory)}`

export async function inventory(port: number, directory: string): Promise<Inventory> {
  const q = locationQuery(directory)
  const list = async (name: string) => ((await api(port, "GET", `/api/${name}?${q}`)) as { data: unknown[] }).data
  return {
    config: (await api(port, "GET", `/api/config?${q}`)) as Inventory["config"],
    mcp: await list("mcp"),
    plugin: await list("plugin"),
    reference: await list("reference"),
  }
}

function parseModel(model: string) {
  const slash = model.indexOf("/")
  const hash = model.indexOf("#")
  const id = hash < 0 ? model.slice(slash + 1) : model.slice(slash + 1, hash)
  return { providerID: model.slice(0, slash), id, ...(hash < 0 ? {} : { variant: model.slice(hash + 1) }) }
}

/** Creates the top-level session up front so its ID is known before admission and its shell env is credential-free. */
export async function createSession(port: number, model: string, directory: string, env: Record<string, string>) {
  const created = (await api(port, "POST", "/api/session", { model: parseModel(model), location: { directory } })) as {
    data: { id: string }
  }
  await api(port, "PUT", `/api/session/${created.data.id}/environment`, { variables: env })
  return created.data.id
}

const GIT_ID = {
  GIT_AUTHOR_NAME: "bench",
  GIT_AUTHOR_EMAIL: "bench@localhost",
  GIT_COMMITTER_NAME: "bench",
  GIT_COMMITTER_EMAIL: "bench@localhost",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
}

/** Task checkouts are separate from harness worktrees; each gets its own git repo seeded from the fixture. */
export function seedTask(task: Task, dir: string, env: Record<string, string>) {
  const gitEnv = { ...env, ...GIT_ID }
  const git = (...cmd: string[]) => must(["git", ...cmd], dir, gitEnv)
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`task checkout ${dir} is not empty`)
  cpSync(path.join(BENCH, "fixtures", task.fixture), dir, { recursive: true })
  git("init", "-q", "-b", "main")
  if (task.scenario !== "permission") {
    git("add", "-A")
    git("commit", "-qm", "initial")
    return
  }
  // main has the hammering loop; fix-retry adds the fixture's exponential backoff; origin is a bare remote with main only.
  const client = path.join(dir, "src", "client.ts")
  const fixed = readFileSync(client, "utf8")
  writeFileSync(
    client,
    fixed
      .split("\n")
      .filter((l) => !l.includes("setTimeout"))
      .join("\n"),
  )
  git("add", "-A")
  git("commit", "-qm", "initial")
  git("checkout", "-q", "-b", "fix-retry")
  writeFileSync(client, fixed)
  git("commit", "-qam", "fix(client): add exponential backoff between retries")
  git("checkout", "-q", "main")
  const remote = path.join(path.dirname(dir), "remote.git")
  must(["git", "init", "-q", "--bare", "-b", "main", remote], path.dirname(dir), gitEnv)
  git("remote", "add", "origin", remote)
  git("push", "-q", "origin", "main")
}

const alive = (p: Bun.Subprocess) => p.exitCode === null && p.signalCode === null

function descendants(pid: number, env: Record<string, string>) {
  const rows = sh(["ps", "-axo", "pid=,ppid="], "/", env)
    .out.split("\n")
    .map((l) => l.trim().split(" ").filter(Boolean).map(Number))
    .filter((r) => r.length === 2 && r.every(Number.isInteger))
  const kids = (p: number): number[] => rows.filter((r) => r[1] === p).flatMap((r) => [r[0], ...kids(r[0])])
  return kids(pid)
}

const pidAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** SIGTERM every owned process and its descendants, wait up to 10s, SIGKILL leftovers. Returns events for anything forced. */
export async function terminate(procs: readonly Bun.Subprocess[]) {
  const env = installEnv(process.env)
  const pids = [...new Set(procs.flatMap((p) => [...(alive(p) ? [p.pid] : []), ...descendants(p.pid, env)]))]
  pids.forEach((pid) => {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && pids.some(pidAlive)) await Bun.sleep(100)
  const stuck = pids.filter(pidAlive)
  stuck.forEach((pid) => {
    try {
      process.kill(pid, "SIGKILL")
    } catch {}
  })
  await Promise.all(procs.map((p) => p.exited))
  return stuck.length ? [`cleanup: SIGKILLed ${stuck.length} process(es) that ignored SIGTERM`] : []
}

export async function startServer(
  wt: string,
  port: number,
  env: Record<string, string>,
  log: string,
  procs: Bun.Subprocess[],
) {
  if (await healthy(port)) throw new Error(`port ${port} already serves OC++; refusing to attach to a live server`)
  const proc = Bun.spawn(
    [
      "bun",
      "--conditions=browser",
      path.join(wt, "packages/cli/src/index.ts"),
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { cwd: env.HOME, env, stdin: "ignore", stdout: Bun.file(log), stderr: Bun.file(log + ".err") },
  )
  procs.push(proc)
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (!alive(proc)) throw new Error(`server exited ${proc.exitCode} before becoming healthy; see ${log}.err`)
    const h = await healthy(port)
    if (h?.status === 200) {
      if (h.body.pid !== proc.pid) throw new Error(`health on ${port} reports pid ${h.body.pid}, spawned ${proc.pid}`)
      const argv = sh(["ps", "-o", "command=", "-p", String(proc.pid)], "/", installEnv(process.env)).out.trim()
      if (!argv.includes(wt)) throw new Error(`server pid ${proc.pid} is not running from ${wt}: ${argv}`)
      return { proc, pid: proc.pid, port, health: h.body, argv }
    }
    await Bun.sleep(250)
  }
  throw new Error(`server on ${port} not healthy within 90s`)
}

type Event = {
  type: string
  sessionID?: string
  part?: {
    type?: string
    text?: string
    cost?: number
    tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
  }
  error?: { message?: string }
}

/** Tolerates truncated or non-JSON lines (e.g. a stream cut by a timeout) and counts them. */
export function parseEvents(stdout: string) {
  const parsed = stdout
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        const v = JSON.parse(l) as Event
        return v && typeof v.type === "string" ? v : undefined
      } catch {
        return undefined
      }
    })
  return {
    events: parsed.filter((e): e is Event => e !== undefined),
    malformed: parsed.filter((e) => e === undefined).length,
  }
}

type SessionRow = {
  id: string
  cost: number | null
  tokens_input: number | null
  tokens_output: number | null
  tokens_reasoning: number | null
  tokens_cache_read: number | null
  tokens_cache_write: number | null
}

export function exportDb(db: string, sessionID: string) {
  const conn = new Database(db, { readonly: true })
  const collect = (frontier: string[], seen: string[]): string[] => {
    if (frontier.length === 0 || seen.length > 500) return seen
    const children = frontier
      .flatMap((id) =>
        (conn.query("select id from session_v2 where parent_id = ?").all(id) as { id: string }[]).map((r) => r.id),
      )
      .filter((c) => !seen.includes(c))
    return collect(children, [...seen, ...children])
  }
  const ids = collect([sessionID], [sessionID])
  const marks = ids.map(() => "?").join(",")
  const out = {
    sessions: conn.query(`select * from session_v2 where id in (${marks})`).all(...ids) as SessionRow[],
    messages: conn
      .query(`select * from session_message where session_id in (${marks}) order by session_id, seq limit 5000`)
      .all(...ids),
    codemode: conn
      .query(
        `select id, session_id, assistant_message_id, tool_call_id, status, substr(program, 1, 20000) as program, ir_version, substr(error, 1, 4000) as error, resumes, time_created, time_updated, time_completed from codemode_execution where session_id in (${marks}) order by time_created limit 1000`,
      )
      .all(...ids) as { status: string }[],
  }
  conn.close()
  return out
}

/** Copies regular files, directories and symlinks; skips sockets and FIFOs left in tmp dirs. */
function archiveDir(from: string, to: string) {
  mkdirSync(path.dirname(to), { recursive: true })
  cpSync(from, to, {
    recursive: true,
    verbatimSymlinks: true,
    filter: (src) => {
      const st = lstatSync(src)
      return st.isFile() || st.isDirectory() || st.isSymbolicLink()
    },
  })
  rmSync(from, { recursive: true, force: true })
}

const ZERO = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

export async function runArm(input: {
  task: Task
  block: { task: string; repeat: number; index: number }
  arm: Arm
  position: number
  sha: string
  wt: string
  cfg: RunConfig
}): Promise<RunRecord> {
  const cfg = input.cfg
  const iso = isolation(cfg.work, input.block, input.arm, cfg.portBase)
  const archive = path.join(cfg.out, "runs", iso.rel)
  const grader = path.join(BENCH, "grader.cjs")
  const procs: Bun.Subprocess[] = []
  const events: string[] = []
  const invalid: string[] = []
  const extra: Record<string, unknown> = { port: iso.port, work: iso.dir, model: cfg.model }
  const base = {
    task: input.task.id,
    repeat: input.block.repeat,
    block: input.block.index,
    arm: input.arm,
    position: input.position,
    sha: input.sha,
    archive: path.relative(cfg.out, archive),
  }
  let phase: "setup" | "run" | "collect" = "setup"

  const body = async (): Promise<RunRecord> => {
    if (existsSync(iso.dir)) throw new Error(`${iso.dir} already exists; arms never reuse state`)
    Object.values(iso.dirs).forEach((d) => mkdirSync(d, { recursive: true }))
    const env = armEnv(iso.dirs, cfg.passEnv, process.env)
    extra.forwardedCredentials = env.secrets
    // Explicit global config: subagent depth pinned; preflight below proves nothing else is in effect.
    const expected = {
      path: path.join(iso.dirs.XDG_CONFIG_HOME, "ocpp", "ocpp.json"),
      info: { experimental: { subagent_depth: cfg.subagentDepth } },
    }
    mkdirSync(path.dirname(expected.path), { recursive: true })
    writeFileSync(expected.path, JSON.stringify(expected.info, null, 2))
    seedTask(input.task, iso.task, env.task)
    writeFileSync(path.join(iso.dir, "before.json"), must(["node", grader, "snapshot", iso.task], iso.task, env.task))
    const server = await startServer(input.wt, iso.port, env.server, path.join(iso.dir, "server.log"), procs)
    extra.server = { pid: server.pid, argv: server.argv, health: server.health }
    if (!existsSync(iso.db) || !within(realpathSync(iso.dirs.XDG_DATA_HOME), realpathSync(iso.db)))
      throw new Error(`isolated database missing at ${iso.db}`)
    const inv = await inventory(iso.port, iso.task)
    writeFileSync(path.join(iso.dir, "preflight.json"), JSON.stringify(inv, null, 2))
    const violations = [
      ...ambientConfig(iso.task).map((p) => `ambient config on ancestor chain: ${p}`),
      ...inventoryViolations(inv, iso.dir, expected),
    ]
    if (violations.length) throw new Error(`preflight: ${violations.join("; ")}`)
    const sessionID = await createSession(iso.port, cfg.model, iso.task, env.task)
    extra.sessionID = sessionID

    phase = "run"
    const started = performance.now()
    const client = Bun.spawn(
      [
        "bun",
        "--conditions=browser",
        path.join(input.wt, "packages/cli/src/index.ts"),
        "run",
        "--server",
        `http://127.0.0.1:${iso.port}`,
        "--session",
        sessionID,
        "--format",
        "json",
        "--model",
        cfg.model,
        input.task.prompt,
      ],
      { cwd: iso.task, env: { ...env.task, PWD: iso.task }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    )
    procs.push(client)
    const stdoutText = new Response(client.stdout).text()
    const stderrText = new Response(client.stderr).text()
    const verdict = await Promise.race([
      client.exited.then(() => "exited" as const),
      server.proc.exited.then(() => "server_died" as const),
      Bun.sleep(input.task.deadlineSec * 1000).then(() => "timeout" as const),
    ])
    if (verdict !== "exited") client.kill("SIGKILL")
    await client.exited
    const wallMs = Math.round(performance.now() - started)
    // Raw streams are preserved before anything parses them.
    const stdout = await stdoutText
    writeFileSync(path.join(iso.dir, "stdout.jsonl"), stdout)
    writeFileSync(path.join(iso.dir, "stderr.txt"), await stderrText)
    const serverAlive = alive(server.proc) && (await healthy(iso.port))?.status === 200
    events.push(...(await terminate([server.proc])))
    extra.verdict = verdict
    extra.exitCode = client.exitCode

    phase = "collect"
    const parsed = parseEvents(stdout)
    if (parsed.malformed) invalid.push(`malformed_jsonl: ${parsed.malformed} line(s)`)
    const streamSession = parsed.events.find((e) => e.sessionID)?.sessionID
    if (streamSession && streamSession !== sessionID)
      events.push(`stream session ${streamSession} != created ${sessionID}`)
    const reply = parsed.events
      .filter((e) => e.type === "text")
      .map((e) => e.part?.text ?? "")
      .join("\n")
    writeFileSync(path.join(iso.dir, "reply.txt"), reply)
    const dump = (() => {
      try {
        return exportDb(iso.db, sessionID)
      } catch (error) {
        invalid.push(`db_export: ${message(error)}`)
        return undefined
      }
    })()
    writeFileSync(path.join(iso.dir, "db.json"), JSON.stringify(dump ?? { error: invalid.at(-1) }, null, 1))
    writeFileSync(
      path.join(iso.dir, "diff.patch"),
      sh(["git", "diff", "HEAD"], iso.task, env.task).out +
        sh(["git", "status", "--porcelain", "--untracked-files=all"], iso.task, env.task).out,
    )
    const gradeRaw = sh(
      [
        "node",
        grader,
        input.task.scenario,
        iso.task,
        path.join(iso.dir, "reply.txt"),
        path.join(iso.dir, "before.json"),
      ],
      iso.task,
      env.task,
    )
    writeFileSync(path.join(iso.dir, "grade.json"), gradeRaw.out + (gradeRaw.code ? gradeRaw.err : ""))
    const grade = (() => {
      try {
        if (gradeRaw.code !== 0) throw new Error(`exit ${gradeRaw.code}: ${gradeRaw.err.slice(0, 200)}`)
        return JSON.parse(gradeRaw.out) as { success: string; conduct: string }
      } catch (error) {
        invalid.push(`grader: ${message(error)}`)
        return undefined
      }
    })()
    extra.grade = grade

    // Usage sums every session in the tree once (each row holds only its own usage); the stream is a parent-only fallback.
    const steps = parsed.events.filter((e) => e.type === "step_finish").map((e) => e.part ?? {})
    const sum = <T>(xs: readonly T[], f: (x: T) => number | null | undefined) => xs.reduce((a, x) => a + (f(x) ?? 0), 0)
    const tokens = dump
      ? {
          input: sum(dump.sessions, (s) => s.tokens_input),
          output: sum(dump.sessions, (s) => s.tokens_output),
          reasoning: sum(dump.sessions, (s) => s.tokens_reasoning),
          cacheRead: sum(dump.sessions, (s) => s.tokens_cache_read),
          cacheWrite: sum(dump.sessions, (s) => s.tokens_cache_write),
        }
      : {
          input: sum(steps, (s) => s.tokens?.input),
          output: sum(steps, (s) => s.tokens?.output),
          reasoning: sum(steps, (s) => s.tokens?.reasoning),
          cacheRead: sum(steps, (s) => s.tokens?.cache?.read),
          cacheWrite: sum(steps, (s) => s.tokens?.cache?.write),
        }
    const rawCost = dump ? sum(dump.sessions, (s) => s.cost) : sum(steps, (s) => s.cost)
    const used = totalTokens(tokens) > 0
    const costSource: CostSource = !used
      ? "none"
      : rawCost > 0
        ? cfg.model.startsWith("claude/")
          ? "sdk_estimate"
          : "provider"
        : "unknown"
    const unfinished = dump
      ? dump.codemode.filter((c) => ["scheduled", "running", "indeterminate"].includes(c.status))
      : []
    const errors = parsed.events.filter((e) => e.type === "error").map((e) => e.error?.message ?? "error")
    const outcome: Outcome =
      verdict === "timeout"
        ? "timeout"
        : verdict === "server_died" || !serverAlive
          ? "server_death"
          : reply.trim() === ""
            ? "missing_delivery"
            : client.exitCode !== 0 || errors.length > 0
              ? "agent_error"
              : "ok"
    return {
      ...base,
      outcome,
      success: outcome === "ok" && invalid.length === 0 && grade?.success === "pass" && grade?.conduct === "pass",
      gradeSuccess: grade?.success,
      conduct: grade?.conduct,
      invalid,
      wallMs,
      tokens,
      cost: costSource === "unknown" ? null : rawCost,
      costSource,
      usageSource: dump ? "db_tree" : steps.length ? "stream" : "none",
      sessions: dump ? dump.sessions.length : 1,
      firstCacheRead: steps.length ? (steps[0].tokens?.cache?.read ?? 0) : null,
      events: [
        ...(outcome === "ok" ? [] : [`${outcome} (exit ${client.exitCode}, ${wallMs}ms)`]),
        ...events,
        ...errors.map((e) => `error event: ${e.slice(0, 200)}`),
        ...unfinished.map((c) => `codemode execution left ${c.status}`),
        ...invalid.map((e) => `invalid: ${e.slice(0, 200)}`),
        ...(grade?.conduct === "fail" ? ["conduct fail"] : []),
      ],
      sessionID,
    }
  }

  const record = await body().catch(
    (error): RunRecord => ({
      ...base,
      outcome: phase === "setup" ? "setup_error" : "runner_error",
      success: false,
      invalid,
      wallMs: 0,
      tokens: ZERO,
      cost: null,
      costSource: "unknown",
      usageSource: "none",
      sessions: 0,
      firstCacheRead: null,
      events: [...events, `${phase}: ${message(error).slice(0, 2000)}`],
      sessionID: typeof extra.sessionID === "string" ? extra.sessionID : undefined,
    }),
  )
  // Always: stop everything this arm owns, then write its envelope and archive it — success or not.
  const final = { ...record, events: [...record.events, ...(await terminate(procs))] }
  const envelope = JSON.stringify({ ...final, ...extra }, null, 2)
  mkdirSync(iso.dir, { recursive: true })
  writeFileSync(path.join(iso.dir, "envelope.json"), envelope)
  try {
    archiveDir(iso.dir, archive)
  } catch (error) {
    mkdirSync(archive, { recursive: true })
    writeFileSync(path.join(archive, "envelope.json"), envelope)
    return { ...final, invalid: [...final.invalid, `archive: ${message(error)}`] }
  }
  return final
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const henv = installEnv(process.env)
  armEnv(Object.fromEntries(ISOLATION_KEYS.map((k) => [k, "/"])), args.passEnv, {})
  const repo = must(["git", "rev-parse", "--show-toplevel"], BENCH, henv)
  const manifest = validateManifest(JSON.parse(readFileSync(args.tasks, "utf8")))
  const unknown = (args.only ?? []).filter((id) => !manifest.some((t) => t.id === id))
  if (unknown.length) throw new Error(`--only names unknown tasks: ${unknown.join(", ")}`)
  const tasks = manifest.filter((t) => !args.only || args.only.includes(t.id))
  const rev = (r: string) => must(["git", "rev-parse", "--verify", "--end-of-options", `${r}^{commit}`], repo, henv)
  const shas: Record<Arm, string> = { A: rev(args.a), B: rev(args.b) }
  const blocks = schedule(
    tasks.map((t) => t.id),
    args.repeats,
    args.seed,
  )
  if (args.portBase + blocks.length * 2 > 65535) throw new Error("--port-base leaves too few ports for this schedule")
  const driver = args.model.startsWith("claude/")
    ? sh(["claude", "--version"], "/", henv).out.trim()
    : args.model.startsWith("codex/")
      ? sh(["codex", "--version"], "/", henv).out.trim()
      : undefined
  if (args.model.startsWith("claude/") && !driver) throw new Error("preflight: claude CLI not found on PATH")
  // Freeze: everything that could differ between arms or across a resume is hashed and recorded before any run.
  const frozen = {
    shas,
    model: args.model,
    repeats: args.repeats,
    seed: args.seed,
    subagentDepth: args.subagentDepth,
    concurrency: 1,
    passEnv: args.passEnv,
    tasks,
    hashes: {
      manifest: hashFile(args.tasks),
      grader: hashFile(path.join(BENCH, "grader.cjs")),
      runner: hashFile(import.meta.path),
      fixtures: hashTree(path.join(BENCH, "fixtures")),
    },
  }
  const prior = prepareOut(args.out, args.resume, frozen)
  const work = args.work ? path.resolve(args.work) : mkdtempSync("/tmp/ocpp-bench-")
  mkdirSync(work, { recursive: true })
  const ambient = ambientConfig(path.join(work, "probe"))
  if (ambient.length) throw new Error(`--work ${work} has config on its ancestor chain: ${ambient.join(", ")}`)
  const cfg: RunConfig = { ...args, work }
  console.error(`[bench] A=${shas.A.slice(0, 10)} B=${shas.B.slice(0, 10)} out=${cfg.out} work=${work}`)
  const arms = Object.fromEntries(
    (["A", "B"] as Arm[]).map((arm) => {
      const wt = path.join(cfg.out, `wt-${shas[arm].slice(0, 12)}`)
      if (!existsSync(wt)) must(["git", "worktree", "add", "--detach", wt, shas[arm]], repo, henv)
      if (must(["git", "rev-parse", "HEAD"], wt, henv) !== shas[arm])
        throw new Error(`worktree ${wt} is not at ${shas[arm]}`)
      console.error(`[bench] install ${arm} ${wt}`)
      must(["bun", "install", "--frozen-lockfile"], wt, henv)
      const dirty = must(["git", "status", "--porcelain", "--untracked-files=no"], wt, henv)
      if (dirty) throw new Error(`worktree ${wt} has tracked changes: ${dirty.slice(0, 500)}`)
      return [
        arm,
        {
          sha: shas[arm],
          worktree: wt,
          head: shas[arm],
          tree: must(["git", "rev-parse", "HEAD^{tree}"], wt, henv),
          lockfile: hashFile(path.join(wt, "bun.lock")),
          clean: true,
        },
      ]
    }),
  ) as Record<Arm, { sha: string; worktree: string; head: string; tree: string; lockfile: string; clean: boolean }>
  const metaFile = path.join(cfg.out, "meta.json")
  const starts = existsSync(metaFile)
    ? ((JSON.parse(readFileSync(metaFile, "utf8")) as { starts?: string[] }).starts ?? [])
    : []
  const meta = {
    frozen,
    a: args.a,
    b: args.b,
    shas,
    model: args.model,
    repeats: args.repeats,
    seed: args.seed,
    sameSha: shas.A === shas.B,
    arms,
    harness: {
      head: must(["git", "rev-parse", "HEAD"], repo, henv),
      dirty: must(["git", "status", "--porcelain"], repo, henv).split("\n").filter(Boolean),
    },
    bun: Bun.version,
    driver,
    work,
    starts: [...starts, new Date().toISOString()],
  }
  writeFileSync(metaFile, JSON.stringify(meta, null, 2))
  const runsFile = path.join(cfg.out, "runs.jsonl")
  const done = new Set(prior.map((r) => `${r.task}:${r.repeat}:${r.arm}`))
  for (const block of blocks) {
    const task = tasks.find((t) => t.id === block.task) as Task
    for (const [position, arm] of block.order.entries()) {
      if (done.has(`${block.task}:${block.repeat}:${arm}`)) continue
      const rel = isolation(work, block, arm, cfg.portBase).rel
      const stale = path.join(cfg.out, "runs", rel)
      // An interrupted attempt is preserved, never overwritten.
      if (existsSync(stale)) {
        const kept = path.join(cfg.out, "attempts", `${rel.split(path.sep).join("-")}-${Date.now()}`)
        mkdirSync(path.dirname(kept), { recursive: true })
        renameSync(stale, kept)
      }
      console.error(`[bench] block ${block.index} ${task.id} r${block.repeat} ${arm}`)
      const record = await runArm({ task, block, arm, position, sha: shas[arm], wt: arms[arm].worktree, cfg })
      console.error(`[bench]   -> ${record.outcome} success=${record.success} ${record.wallMs}ms`)
      appendFileSync(runsFile, JSON.stringify(record) + "\n")
    }
  }
  // Reports are always computed from the full JSONL, so they never disagree with it.
  const runs = prepareOut(cfg.out, true, frozen)
  const summary = summarize(runs, cfg.seed)
  writeFileSync(
    path.join(cfg.out, "report.json"),
    JSON.stringify({ meta: { ...meta, finished: new Date().toISOString() }, tasks: summary }, null, 2),
  )
  writeFileSync(path.join(cfg.out, "report.md"), markdown(meta, summary))
  if (!cfg.keepWorktrees)
    new Set(Object.values(arms).map((a) => a.worktree)).forEach((wt) =>
      sh(["git", "worktree", "remove", "--force", wt], repo, henv),
    )
  if (!args.work) rmSync(work, { recursive: true, force: true })
  console.log(readFileSync(path.join(cfg.out, "report.md"), "utf8"))
}

if (import.meta.main) await main()
