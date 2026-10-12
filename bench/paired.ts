#!/usr/bin/env bun
// Paired-commit benchmark runner. Runs one task manifest under two OC++ commits with the same model,
// each arm/repeat against its own freshly isolated server, and writes runs.jsonl + report.json + report.md.
// See bench/README.md. Reuses the existing headless entry (`run --format json`) — no agent loop here.
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, appendFileSync } from "node:fs"
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

export function validateManifest(input: unknown, fixturesDir = path.join(BENCH, "fixtures")) {
  if (!Array.isArray(input) || input.length === 0) throw new Error("manifest must be a non-empty array")
  const ids = new Set<string>()
  return input.map((raw, i) => {
    const t = raw as Partial<Task>
    const where = `tasks[${i}]`
    if (typeof t.id !== "string" || !t.id) throw new Error(`${where}.id must be a non-empty string`)
    if (ids.has(t.id)) throw new Error(`${where}.id ${t.id} is duplicated`)
    ids.add(t.id)
    if (typeof t.prompt !== "string" || !t.prompt.trim()) throw new Error(`${where}.prompt must be non-empty`)
    if (typeof t.fixture !== "string" || !existsSync(path.join(fixturesDir, t.fixture)))
      throw new Error(`${where}.fixture ${t.fixture} does not exist under ${fixturesDir}`)
    if (typeof t.scenario !== "string" || !SCENARIOS.includes(t.scenario))
      throw new Error(`${where}.scenario must be one of ${SCENARIOS.join(", ")}`)
    if (typeof t.toolsKind !== "string" || !t.toolsKind) throw new Error(`${where}.toolsKind must be a string`)
    if (typeof t.deadlineSec !== "number" || !(t.deadlineSec > 0)) throw new Error(`${where}.deadlineSec must be > 0`)
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

/** Fresh HOME/XDG/TMPDIR and a distinct loopback port for every (block, arm). */
export function isolation(root: string, block: { task: string; repeat: number; index: number }, arm: Arm, portBase: number) {
  const dir = path.join(root, "runs", block.task, `r${block.repeat}`, arm)
  const dirs = {
    HOME: path.join(dir, "home"),
    XDG_DATA_HOME: path.join(dir, "xdg", "data"),
    XDG_CONFIG_HOME: path.join(dir, "xdg", "config"),
    XDG_CACHE_HOME: path.join(dir, "xdg", "cache"),
    XDG_STATE_HOME: path.join(dir, "xdg", "state"),
    TMPDIR: path.join(dir, "tmp"),
  }
  return {
    dir,
    task: path.join(dir, "task"),
    dirs,
    db: path.join(dirs.XDG_DATA_HOME, "ocpp", "ocpp-local.db"),
    port: portBase + block.index * 2 + (arm === "A" ? 0 : 1),
  }
}

export function quantile(sorted: readonly number[], q: number) {
  if (sorted.length === 0) return Number.NaN
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Number.NaN)

/** Percentile bootstrap of the mean paired difference (B - A). */
export function bootstrap(diffs: readonly number[], seed: number, resamples = 2000) {
  if (diffs.length === 0) return { mean: Number.NaN, lo: Number.NaN, hi: Number.NaN, n: 0 }
  const next = rng(seed)
  const means = Array.from({ length: resamples }, () =>
    mean(Array.from({ length: diffs.length }, () => diffs[Math.floor(next() * diffs.length)])),
  ).sort((a, b) => a - b)
  return { mean: mean(diffs), lo: quantile(means, 0.025), hi: quantile(means, 0.975), n: diffs.length }
}

export type Outcome = "ok" | "timeout" | "server_death" | "missing_delivery" | "agent_error" | "setup_error"

export type RunRecord = {
  task: string
  repeat: number
  block: number
  arm: Arm
  position: number
  sha: string
  outcome: Outcome
  success: boolean
  conduct?: string
  wallMs: number
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  cost: number
  cache: "warm" | "cold" | "unknown"
  events: string[]
  sessionID?: string
  archive: string
}

const RELIABILITY: Outcome[] = ["timeout", "server_death", "missing_delivery", "agent_error"]

export function summarize(runs: readonly RunRecord[], seed: number) {
  const tasks = [...new Set(runs.map((r) => r.task))]
  return tasks.map((task, ti) => {
    const mine = runs.filter((r) => r.task === task)
    const admitted = mine.filter((r) => r.outcome !== "setup_error")
    const arm = (a: Arm) => {
      const rs = admitted.filter((r) => r.arm === a)
      return {
        n: rs.length,
        success: rs.length ? rs.filter((r) => r.success).length / rs.length : Number.NaN,
        wallMs: mean(rs.map((r) => r.wallMs)),
        tokens: mean(rs.map((r) => r.tokens.input + r.tokens.output + r.tokens.reasoning)),
        cost: mean(rs.map((r) => r.cost)),
        timeouts: rs.filter((r) => r.outcome === "timeout").length,
        reliability: rs.filter((r) => RELIABILITY.includes(r.outcome)).length,
        setupErrors: mine.filter((r) => r.arm === a && r.outcome === "setup_error").length,
        events: rs.flatMap((r) => r.events),
        strata: { warm: rs.filter((r) => r.cache === "warm").length, cold: rs.filter((r) => r.cache === "cold").length },
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
          tokenDelta:
            b.tokens.input + b.tokens.output + b.tokens.reasoning - (a.tokens.input + a.tokens.output + a.tokens.reasoning),
          costDelta: b.cost - a.cost,
        },
      ]
    })
    const A = arm("A")
    const B = arm("B")
    return {
      task,
      A,
      B,
      pairedDiff: bootstrap(
        pairs.map((p) => p.diff),
        seed + ti + 1,
      ),
      wallDeltaMs: mean(pairs.map((p) => p.wallDeltaMs)),
      tokenDelta: mean(pairs.map((p) => p.tokenDelta)),
      costDelta: mean(pairs.map((p) => p.costDelta)),
      pairs,
    }
  })
}

const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "—")

export function markdown(meta: Record<string, unknown>, summary: ReturnType<typeof summarize>) {
  const head = [
    `# Paired benchmark ${String(meta.a)} (A) vs ${String(meta.b)} (B)`,
    "",
    `model \`${String(meta.model)}\` · repeats ${String(meta.repeats)} · seed ${String(meta.seed)} · diff = B − A (success), 95% paired bootstrap`,
    "",
    "| task | A succ | B succ | B−A [95% CI] | Δwall s | Δtokens | Δcost $ | A to/rel/setup | B to/rel/setup |",
    "|---|---|---|---|---|---|---|---|---|",
  ]
  const rows = summary.map(
    (s) =>
      `| ${s.task} | ${fmt(s.A.success)} (n=${s.A.n}) | ${fmt(s.B.success)} (n=${s.B.n}) | ${fmt(s.pairedDiff.mean)} [${fmt(s.pairedDiff.lo)}, ${fmt(s.pairedDiff.hi)}] | ${fmt(s.wallDeltaMs / 1000, 1)} | ${fmt(s.tokenDelta, 0)} | ${fmt(s.costDelta, 4)} | ${s.A.timeouts}/${s.A.reliability}/${s.A.setupErrors} | ${s.B.timeouts}/${s.B.reliability}/${s.B.setupErrors} |`,
  )
  const events = summary.flatMap((s) => [...s.A.events.map((e) => `- ${s.task} A: ${e}`), ...s.B.events.map((e) => `- ${s.task} B: ${e}`)])
  return [
    ...head,
    ...rows,
    "",
    "## Reliability events",
    ...(events.length ? events : ["- none"]),
    "",
    "Timeouts, server death, missing delivery and agent errors count as failures; setup errors are excluded from pairs. Few repeats ⇒ wide intervals.",
    "",
  ].join("\n")
}

// ---------------------------------------------------------------------------------------------------------------
// Orchestration (only when executed directly)

function sh(cmd: string[], cwd: string, env?: Record<string, string>) {
  const p = Bun.spawnSync(cmd, { cwd, env: env ?? (process.env as Record<string, string>), stdout: "pipe", stderr: "pipe" })
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() }
}

function must(cmd: string[], cwd: string, env?: Record<string, string>) {
  const r = sh(cmd, cwd, env)
  if (r.code !== 0) throw new Error(`${cmd.join(" ")} (cwd ${cwd}) exited ${r.code}: ${r.err || r.out}`)
  return r.out.trim()
}

function hashTree(dir: string): string {
  const walk = (d: string): string[] =>
    readdirSync(d)
      .sort()
      .flatMap((name) => {
        const p = path.join(d, name)
        return statSync(p).isDirectory() ? walk(p) : [p]
      })
  const h = createHash("sha256")
  walk(dir).forEach((f) => h.update(path.relative(dir, f) + "\0").update(readFileSync(f)))
  return h.digest("hex")
}

const hashFile = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex")

function args(argv: string[]) {
  const get = (name: string) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const a = get("a")
  const b = get("b")
  const model = get("model")
  if (!a || !b || !model) throw new Error("usage: bun bench/paired.ts --a <sha> --b <sha> --model <provider/model#variant> [--tasks bench/tasks.json] [--repeats 3] [--out dir] [--seed 1] [--only id,id] [--pass-env NAME,NAME] [--subagent-depth 1] [--port-base 18081] [--keep-worktrees]")
  const ts = new Date().toISOString().replace(/[:.]/g, "-")
  return {
    a,
    b,
    model,
    tasks: path.resolve(get("tasks") ?? path.join(BENCH, "tasks.json")),
    repeats: Number(get("repeats") ?? 3),
    out: path.resolve(get("out") ?? path.join(BENCH, "out", ts)),
    seed: Number(get("seed") ?? 1),
    only: get("only")?.split(",").filter(Boolean),
    passEnv: (get("pass-env") ?? "CLAUDE_CODE_OAUTH_TOKEN,ANTHROPIC_API_KEY,OPENAI_API_KEY").split(",").filter(Boolean),
    subagentDepth: Number(get("subagent-depth") ?? 1),
    portBase: Number(get("port-base") ?? 18081),
    keepWorktrees: argv.includes("--keep-worktrees"),
  }
}

async function healthy(port: number) {
  return fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) })
    .then(async (r) => ({ status: r.status, body: (await r.json()) as { healthy?: boolean; version?: string; pid?: number } }))
    .catch(() => undefined)
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
function seedTask(task: Task, dir: string, env: Record<string, string>) {
  const gitEnv = { ...env, ...GIT_ID }
  const git = (...cmd: string[]) => must(["git", ...cmd], dir, gitEnv)
  cpSync(path.join(BENCH, "fixtures", task.fixture), dir, { recursive: true })
  git("init", "-q", "-b", "main")
  if (task.scenario !== "permission") {
    git("add", "-A")
    git("commit", "-qm", "initial")
    return
  }
  // main has the hammering loop; fix-retry adds the fixture's exponential backoff; origin is a bare remote with main.
  const client = path.join(dir, "src", "client.ts")
  const fixed = readFileSync(client, "utf8")
  writeFileSync(client, fixed.split("\n").filter((l) => !l.includes("setTimeout")).join("\n"))
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

type Server = { proc: Bun.Subprocess; pid: number; port: number; log: string }

async function startServer(wt: string, port: number, env: Record<string, string>, log: string): Promise<Server> {
  if (await healthy(port)) throw new Error(`port ${port} already serves OC++; refusing to attach to a live server`)
  const proc = Bun.spawn(["bun", "--conditions=browser", path.join(wt, "packages/cli/src/index.ts"), "serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: env.HOME,
    env,
    stdin: "ignore",
    stdout: Bun.file(log),
    stderr: Bun.file(log + ".err"),
  })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`server exited ${proc.exitCode} before becoming healthy; see ${log}.err`)
    const h = await healthy(port)
    if (h?.status === 200) {
      if (h.body.pid !== proc.pid) throw new Error(`health on ${port} reports pid ${h.body.pid}, spawned ${proc.pid}`)
      const cmd = sh(["ps", "-o", "command=", "-p", String(proc.pid)], "/").out
      if (!cmd.includes(wt)) throw new Error(`server pid ${proc.pid} is not running from ${wt}: ${cmd}`)
      return { proc, pid: proc.pid, port, log }
    }
    await Bun.sleep(250)
  }
  proc.kill()
  throw new Error(`server on ${port} not healthy within 90s`)
}

async function stopServer(server: Server) {
  if (server.proc.exitCode !== null) return
  server.proc.kill("SIGTERM")
  const done = await Promise.race([server.proc.exited.then(() => true), Bun.sleep(10_000).then(() => false)])
  if (!done) server.proc.kill("SIGKILL")
  await server.proc.exited
}

type Event = { type: string; sessionID?: string; part?: { type?: string; text?: string; cost?: number; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }; error?: { message?: string } }

function parseEvents(stdout: string) {
  return stdout
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .flatMap((l) => {
      const parsed = JSON.parse(l) as Event
      return parsed && typeof parsed.type === "string" ? [parsed] : []
    })
}

function exportDb(db: string, sessionID: string | undefined) {
  if (!sessionID || !existsSync(db)) return { found: false as const }
  const conn = new Database(db, { readonly: true })
  const ids = (function collect(frontier: string[], seen: string[]): string[] {
    if (frontier.length === 0 || seen.length > 200) return seen
    const children = frontier.flatMap((id) =>
      (conn.query("select id from session_v2 where parent_id = ?").all(id) as { id: string }[]).map((r) => r.id),
    )
    return collect(children.filter((c) => !seen.includes(c)), [...seen, ...children.filter((c) => !seen.includes(c))])
  })([sessionID], [sessionID])
  const marks = ids.map(() => "?").join(",")
  const out = {
    found: true as const,
    sessions: conn.query(`select * from session_v2 where id in (${marks})`).all(...ids),
    messages: conn.query(`select * from session_message where session_id in (${marks}) order by session_id, seq limit 5000`).all(...ids),
    codemode: conn
      .query(`select id, session_id, assistant_message_id, tool_call_id, status, substr(program, 1, 20000) as program, ir_version, substr(error, 1, 4000) as error, resumes, time_created, time_updated, time_completed from codemode_execution where session_id in (${marks}) order by time_created limit 1000`)
      .all(...ids) as { status: string }[],
  }
  conn.close()
  return out
}

async function runArm(input: {
  task: Task
  block: { task: string; repeat: number; index: number }
  arm: Arm
  position: number
  sha: string
  wt: string
  cfg: ReturnType<typeof args>
}): Promise<RunRecord> {
  const iso = isolation(input.cfg.out, input.block, input.arm, input.cfg.portBase)
  const base = {
    task: input.task.id,
    repeat: input.block.repeat,
    block: input.block.index,
    arm: input.arm,
    position: input.position,
    sha: input.sha,
    archive: path.relative(input.cfg.out, iso.dir),
  }
  const zero = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  Object.values(iso.dirs).forEach((d) => mkdirSync(d, { recursive: true }))
  mkdirSync(iso.task, { recursive: true })
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    ...iso.dirs,
    ...Object.fromEntries(input.cfg.passEnv.flatMap((k) => (process.env[k] ? [[k, process.env[k] as string]] : []))),
  }
  // Explicit config: subagent depth pinned, no MCP servers or plugins (fresh config dir has none otherwise).
  mkdirSync(path.join(iso.dirs.XDG_CONFIG_HOME, "ocpp"), { recursive: true })
  writeFileSync(path.join(iso.dirs.XDG_CONFIG_HOME, "ocpp", "ocpp.json"), JSON.stringify({ experimental: { subagent_depth: input.cfg.subagentDepth } }, null, 2))
  const setup = await (async () => {
    seedTask(input.task, iso.task, env)
    const before = must(["node", path.join(BENCH, "grader.cjs"), "snapshot", iso.task], iso.task, env)
    writeFileSync(path.join(iso.dir, "before.json"), before)
    const server = await startServer(input.wt, iso.port, env, path.join(iso.dir, "server.log"))
    // Admission check: the isolated DB must exist inside this arm's XDG_DATA_HOME, never the user's.
    if (!existsSync(iso.db)) throw new Error(`isolated database missing at ${iso.db}`)
    return server
  })().then(
    (server) => ({ server }),
    (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
  )
  if ("error" in setup) {
    const record = { ...base, outcome: "setup_error" as const, success: false, wallMs: 0, tokens: zero, cost: 0, cache: "unknown" as const, events: [`setup: ${setup.error}`] }
    writeFileSync(path.join(iso.dir, "envelope.json"), JSON.stringify(record, null, 2))
    return record
  }
  const server = setup.server
  const started = performance.now()
  const client = Bun.spawn(
    ["bun", "--conditions=browser", path.join(input.wt, "packages/cli/src/index.ts"), "run", "--server", `http://127.0.0.1:${iso.port}`, "--format", "json", "--model", input.cfg.model, input.task.prompt],
    { cwd: iso.task, env: { ...env, PWD: iso.task }, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  )
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
  const stdout = await stdoutText
  const stderr = await stderrText
  const serverAlive = server.proc.exitCode === null && (await healthy(iso.port))?.status === 200
  await stopServer(server)
  writeFileSync(path.join(iso.dir, "stdout.jsonl"), stdout)
  writeFileSync(path.join(iso.dir, "stderr.txt"), stderr)
  const events = parseEvents(stdout)
  const sessionID = events.find((e) => e.sessionID)?.sessionID
  const reply = events
    .filter((e) => e.type === "text")
    .map((e) => e.part?.text ?? "")
    .join("\n")
  writeFileSync(path.join(iso.dir, "reply.txt"), reply)
  const dump = exportDb(iso.db, sessionID)
  writeFileSync(path.join(iso.dir, "db.json"), JSON.stringify(dump, null, 1))
  writeFileSync(path.join(iso.dir, "diff.patch"), sh(["git", "diff", "HEAD"], iso.task, env).out + sh(["git", "status", "--porcelain", "--untracked-files=all"], iso.task, env).out)
  const gradeRaw = sh(["node", path.join(BENCH, "grader.cjs"), input.task.scenario, iso.task, path.join(iso.dir, "reply.txt"), path.join(iso.dir, "before.json")], iso.task, env)
  writeFileSync(path.join(iso.dir, "grade.json"), gradeRaw.out)
  const grade = (gradeRaw.code === 0 && gradeRaw.out.trim().startsWith("{") ? JSON.parse(gradeRaw.out) : { success: "error", conduct: "error" }) as { success: string; conduct: string }
  const session = dump.found ? (dump.sessions.find((s) => (s as { id: string }).id === sessionID) as Record<string, number> | undefined) : undefined
  const steps = events.filter((e) => e.type === "step_finish").map((e) => e.part ?? {})
  const tokens = session
    ? { input: session.tokens_input ?? 0, output: session.tokens_output ?? 0, reasoning: session.tokens_reasoning ?? 0, cacheRead: session.tokens_cache_read ?? 0, cacheWrite: session.tokens_cache_write ?? 0 }
    : {
        input: steps.reduce((a, s) => a + (s.tokens?.input ?? 0), 0),
        output: steps.reduce((a, s) => a + (s.tokens?.output ?? 0), 0),
        reasoning: steps.reduce((a, s) => a + (s.tokens?.reasoning ?? 0), 0),
        cacheRead: steps.reduce((a, s) => a + (s.tokens?.cache?.read ?? 0), 0),
        cacheWrite: steps.reduce((a, s) => a + (s.tokens?.cache?.write ?? 0), 0),
      }
  const cost = session?.cost ?? steps.reduce((a, s) => a + (s.cost ?? 0), 0)
  const unfinished = dump.found ? dump.codemode.filter((c) => ["scheduled", "running", "indeterminate"].includes(c.status)) : []
  const errors = events.filter((e) => e.type === "error").map((e) => e.error?.message ?? "error")
  const outcome: Outcome =
    verdict === "timeout"
      ? "timeout"
      : verdict === "server_died" || !serverAlive
        ? "server_death"
        : !sessionID || reply.trim() === ""
          ? "missing_delivery"
          : client.exitCode !== 0 || errors.length > 0
            ? "agent_error"
            : "ok"
  const record: RunRecord = {
    ...base,
    outcome,
    success: outcome === "ok" && grade.success === "pass",
    conduct: grade.conduct,
    wallMs,
    tokens,
    cost,
    cache: tokens.cacheRead > 0 ? "warm" : steps.length ? "cold" : "unknown",
    events: [
      ...(outcome === "ok" ? [] : [`${outcome} (exit ${client.exitCode}, ${wallMs}ms)`]),
      ...errors.map((e) => `error event: ${e.slice(0, 200)}`),
      ...unfinished.map((c) => `codemode execution left ${c.status}`),
      ...(grade.conduct === "fail" ? ["conduct fail"] : []),
    ],
    sessionID,
  }
  writeFileSync(path.join(iso.dir, "envelope.json"), JSON.stringify({ ...record, exitCode: client.exitCode, verdict, serverPid: server.pid, port: iso.port, grade }, null, 2))
  return record
}

async function main() {
  const cfg = args(process.argv.slice(2))
  const repo = must(["git", "rev-parse", "--show-toplevel"], BENCH)
  const tasks = validateManifest(JSON.parse(readFileSync(cfg.tasks, "utf8"))).filter((t) => !cfg.only || cfg.only.includes(t.id))
  if (tasks.length === 0) throw new Error("no tasks selected")
  mkdirSync(cfg.out, { recursive: true })
  const shas = { A: must(["git", "rev-parse", "--verify", `${cfg.a}^{commit}`], repo), B: must(["git", "rev-parse", "--verify", `${cfg.b}^{commit}`], repo) }
  const driver = cfg.model.startsWith("claude/") ? sh(["claude", "--version"], "/").out.trim() : cfg.model.startsWith("codex/") ? sh(["codex", "--version"], "/").out.trim() : undefined
  if (cfg.model.startsWith("claude/") && !driver) throw new Error("preflight: claude CLI not found on PATH")
  const missing = cfg.passEnv.filter((k) => !process.env[k])
  // Freeze: everything that could differ between arms is hashed and recorded before any run.
  const meta = {
    a: cfg.a,
    b: cfg.b,
    shas,
    model: cfg.model,
    repeats: cfg.repeats,
    seed: cfg.seed,
    subagentDepth: cfg.subagentDepth,
    concurrency: 1,
    tasks: tasks.map((t) => ({ id: t.id, deadlineSec: t.deadlineSec, scenario: t.scenario })),
    hashes: {
      manifest: hashFile(cfg.tasks),
      grader: hashFile(path.join(BENCH, "grader.cjs")),
      runner: hashFile(import.meta.path),
      fixtures: hashTree(path.join(BENCH, "fixtures")),
    },
    harness: { head: must(["git", "rev-parse", "HEAD"], repo), dirty: must(["git", "status", "--porcelain"], repo).split("\n").filter(Boolean) },
    bun: Bun.version,
    driver,
    passEnv: cfg.passEnv.filter((k) => !missing.includes(k)),
    started: new Date().toISOString(),
  }
  writeFileSync(path.join(cfg.out, "meta.json"), JSON.stringify(meta, null, 2))
  console.error(`[bench] A=${shas.A.slice(0, 10)} B=${shas.B.slice(0, 10)} out=${cfg.out}`)
  const worktrees = Object.fromEntries(
    (["A", "B"] as Arm[]).map((arm) => {
      const wt = path.join(cfg.out, `wt-${shas[arm].slice(0, 12)}`)
      if (!existsSync(wt)) must(["git", "worktree", "add", "--detach", wt, shas[arm]], repo)
      if (must(["git", "rev-parse", "HEAD"], wt) !== shas[arm]) throw new Error(`worktree ${wt} is not at ${shas[arm]}`)
      console.error(`[bench] install ${arm} ${wt}`)
      must(["bun", "install", "--frozen-lockfile"], wt)
      return [arm, wt]
    }),
  ) as Record<Arm, string>
  const runsFile = path.join(cfg.out, "runs.jsonl")
  const blocks = schedule(
    tasks.map((t) => t.id),
    cfg.repeats,
    cfg.seed,
  )
  const runs: RunRecord[] = []
  for (const block of blocks) {
    const task = tasks.find((t) => t.id === block.task) as Task
    for (const [position, arm] of block.order.entries()) {
      console.error(`[bench] block ${block.index} ${task.id} r${block.repeat} ${arm}`)
      const record = await runArm({ task, block, arm, position, sha: shas[arm], wt: worktrees[arm], cfg })
      console.error(`[bench]   -> ${record.outcome} success=${record.success} ${record.wallMs}ms`)
      appendFileSync(runsFile, JSON.stringify(record) + "\n")
      runs.push(record)
    }
  }
  const summary = summarize(runs, cfg.seed)
  writeFileSync(path.join(cfg.out, "report.json"), JSON.stringify({ meta: { ...meta, finished: new Date().toISOString() }, tasks: summary }, null, 2))
  writeFileSync(path.join(cfg.out, "report.md"), markdown(meta, summary))
  if (!cfg.keepWorktrees) Object.values(worktrees).forEach((wt) => sh(["git", "worktree", "remove", "--force", wt], repo))
  console.log(readFileSync(path.join(cfg.out, "report.md"), "utf8"))
}

if (import.meta.main) await main()
