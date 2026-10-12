import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, cpSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  ambientConfig,
  api,
  armEnv,
  bootstrap,
  CREDENTIALS,
  createSession,
  installEnv,
  inventory,
  inventoryViolations,
  isolation,
  locationQuery,
  markdown,
  parseEvents,
  prepareOut,
  runArm,
  schedule,
  seedTask,
  startServer,
  summarize,
  terminate,
  validateManifest,
  type RunConfig,
  type RunRecord,
  type Task,
} from "./paired"

const BENCH = import.meta.dir
const REPO = path.join(BENCH, "..")
const tasks = validateManifest(await Bun.file(path.join(BENCH, "tasks.json")).json())
const tmp = (name: string) => mkdtempSync(path.join("/tmp", `bench-test-${name}-`))
const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", ...args], { cwd })
    .stdout.toString()
    .trim()
const grade = (scenario: string, dir: string, reply: string, before: string) => {
  const replyFile = path.join(path.dirname(dir), "reply.txt")
  writeFileSync(replyFile, reply)
  const r = Bun.spawnSync(["node", path.join(BENCH, "grader.cjs"), scenario, dir, replyFile, before], { cwd: dir })
  return JSON.parse(r.stdout.toString()) as { success: string; conduct: string; details: Record<string, unknown> }
}
const seeded = (id: string) => {
  const root = tmp(id)
  const dir = path.join(root, "task")
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root }
  seedTask(tasks.find((t) => t.id === id) as Task, dir, env)
  const before = path.join(root, "before.json")
  writeFileSync(
    before,
    Bun.spawnSync(["node", path.join(BENCH, "grader.cjs"), "snapshot", dir], { cwd: dir }).stdout.toString(),
  )
  return { root, dir, before }
}
const portBase = () => 20000 + Math.floor(Math.random() * 20000) * 2
const record = (repeat: number, arm: "A" | "B", over: Partial<RunRecord>): RunRecord => ({
  task: "t",
  repeat,
  block: repeat,
  arm,
  position: arm === "A" ? 0 : 1,
  sha: arm,
  outcome: "ok",
  success: true,
  gradeSuccess: "pass",
  conduct: "pass",
  invalid: [],
  wallMs: 1000,
  tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  cost: 0.01,
  costSource: "sdk_estimate",
  usageSource: "db_tree",
  sessions: 1,
  firstCacheRead: 0,
  events: [],
  archive: "",
  ...over,
})
const meta = { a: "a", b: "b", shas: { A: "1", B: "2" }, model: "claude/sonnet", repeats: 1, seed: 1 }

describe("manifest (M4)", () => {
  test("shipped manifest is valid and skips orch", () => {
    expect(tasks.map((t) => t.id).sort()).toEqual(["grounding", "noedit", "pattern", "permission", "shrink"])
  })

  test("rejects duplicates, unsafe ids/fixtures, unknown scenarios and bad deadlines", () => {
    const ok = tasks[0]
    expect(() => validateManifest([])).toThrow("non-empty")
    expect(() => validateManifest([ok, ok])).toThrow("duplicated")
    expect(() => validateManifest([{ ...ok, id: "../../../escape" }])).toThrow("safe path component")
    expect(() => validateManifest([{ ...ok, id: "a/b" }])).toThrow("safe path component")
    expect(() => validateManifest([{ ...ok, id: ".." }])).toThrow("safe path component")
    expect(() => validateManifest([{ ...ok, fixture: "../fixtures/noedit" }])).toThrow("safe path component")
    expect(() => validateManifest([{ ...ok, fixture: "nope" }])).toThrow("does not exist")
    expect(() => validateManifest([{ ...ok, scenario: "orch" }])).toThrow("scenario")
    expect(() => validateManifest([{ ...ok, deadlineSec: 0 }])).toThrow("deadlineSec")
    expect(() => validateManifest([{ ...ok, deadlineSec: 1.5 }])).toThrow("deadlineSec")
    expect(() => validateManifest([{ ...ok, prompt: " " }])).toThrow("prompt")
  })

  test("rejects fixtures that resolve outside the fixture root or contain symlinks", () => {
    const root = tmp("fixtures")
    const outside = tmp("outside")
    mkdirSync(path.join(root, "fixtures", "inner"), { recursive: true })
    symlinkSync(outside, path.join(root, "fixtures", "linked"))
    symlinkSync("/etc/hosts", path.join(root, "fixtures", "inner", "hosts"))
    const t = { ...tasks[0], fixture: "linked" }
    expect(() => validateManifest([t], path.join(root, "fixtures"))).toThrow("does not exist")
    expect(() => validateManifest([{ ...t, fixture: "inner" }], path.join(root, "fixtures"))).toThrow("symlink")
  })

  test("isolation refuses ids that would escape the work root", () => {
    expect(() => isolation("/tmp/bench-review", { task: "../../../escape", repeat: 0, index: 0 }, "A", 18081)).toThrow(
      "unsafe",
    )
  })
})

describe("isolation and credentials (M2)", () => {
  test("every arm and repeat gets distinct HOME/XDG/TMPDIR roots and ports under the work root", () => {
    const root = tmp("iso")
    const all = schedule(["noedit", "grounding"], 3, 7).flatMap((b) =>
      (["A", "B"] as const).map((arm) => isolation(root, b, arm, 18081)),
    )
    expect(new Set(all.map((i) => i.port)).size).toBe(all.length)
    const keys = Object.keys(all[0].dirs)
    expect(keys.sort()).toEqual([
      "HOME",
      "TMPDIR",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
    ])
    keys.forEach((k) => expect(new Set(all.map((i) => (i.dirs as Record<string, string>)[k])).size).toBe(all.length))
    all.forEach((i) => {
      Object.values(i.dirs).forEach((d) => expect(d.startsWith(root + "/")).toBe(true))
      expect(i.db.startsWith(i.dirs.XDG_DATA_HOME)).toBe(true)
      expect(i.task.startsWith(i.dir)).toBe(true)
    })
  })

  test("--pass-env cannot name isolation roots or arbitrary variables", () => {
    const dirs = isolation("/tmp/x", { task: "t", repeat: 0, index: 0 }, "A", 18081).dirs
    expect(() => armEnv(dirs, ["HOME"], {})).toThrow("only accepts")
    expect(() => armEnv(dirs, ["XDG_DATA_HOME"], {})).toThrow("only accepts")
    expect(() => armEnv(dirs, ["AWS_SECRET_ACCESS_KEY"], {})).toThrow("only accepts")
  })

  test("credentials reach only the server env; isolation roots always win", () => {
    const dirs = isolation("/tmp/x", { task: "t", repeat: 0, index: 0 }, "A", 18081).dirs
    const source = {
      PATH: "/bin",
      HOME: "/Users/someone",
      XDG_DATA_HOME: "/Users/someone/.local/share",
      CLAUDE_CODE_OAUTH_TOKEN: "sentinel-secret",
      AWS_SECRET_ACCESS_KEY: "nope",
    }
    const env = armEnv(dirs, ["CLAUDE_CODE_OAUTH_TOKEN"], source)
    expect(env.server.CLAUDE_CODE_OAUTH_TOKEN).toBe("sentinel-secret")
    expect(env.secrets).toEqual(["CLAUDE_CODE_OAUTH_TOKEN"])
    ;[env.task, env.server].forEach((e) => {
      Object.entries(dirs).forEach(([k, v]) => expect(e[k]).toBe(v))
      expect(e.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    })
    expect(JSON.stringify(env.task)).not.toContain("sentinel-secret")
    CREDENTIALS.forEach((k) => expect(env.task[k]).toBeUndefined())
    const install = installEnv({ ...source, OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "y" })
    expect(Object.keys(install).sort()).toEqual(["HOME", "LANG", "PATH"])
  })
})

describe("output directory (M3)", () => {
  const frozen = { shas: { A: "1", B: "2" }, seed: 1 }
  test("fresh or missing directories are accepted", () => {
    expect(prepareOut(path.join(tmp("out"), "new"), false, frozen)).toEqual([])
    expect(prepareOut(tmp("out"), false, frozen)).toEqual([])
  })
  test("non-empty --out is refused unless --resume with identical frozen inputs", () => {
    const out = tmp("out")
    writeFileSync(path.join(out, "meta.json"), JSON.stringify({ frozen }))
    writeFileSync(path.join(out, "runs.jsonl"), JSON.stringify(record(0, "A", {})) + "\n")
    expect(() => prepareOut(out, false, frozen)).toThrow("not empty")
    expect(() => prepareOut(out, true, { ...frozen, seed: 2 })).toThrow("frozen inputs differ")
    expect(prepareOut(out, true, frozen).length).toBe(1)
    const bare = tmp("out")
    writeFileSync(path.join(bare, "stray"), "")
    expect(() => prepareOut(bare, true, frozen)).toThrow("meta.json is missing")
  })
})

describe("effective configuration (M1)", () => {
  const root = "/tmp/iso-root"
  const expected = { path: "/tmp/iso-root/xdg/config/ocpp/ocpp.json", info: { experimental: { subagent_depth: 1 } } }
  const clean = {
    config: [
      { type: "document", path: expected.path, info: expected.info },
      { type: "directory", path: "/tmp/iso-root/xdg/config/ocpp" },
    ],
    mcp: [],
    plugin: [],
    reference: [],
  }
  test("the generated config alone passes", () => {
    expect(inventoryViolations(clean, root, expected)).toEqual([])
  })
  test("ancestor documents, home dirs, MCP servers, plugins and references are violations", () => {
    const hostile = {
      config: [
        { type: "claude", path: "/Users/someone/.claude" },
        ...clean.config,
        { type: "document", path: "/repo/.ocpp/ocpp.jsonc", info: { mcp: { evil: {} } } },
      ],
      mcp: [{ name: "evil" }],
      plugin: [{ name: "p" }],
      reference: [{ name: "r" }],
    }
    const v = inventoryViolations(hostile, root, expected).join("\n")
    expect(v).toContain("outside isolation: claude /Users/someone/.claude")
    expect(v).toContain("unexpected config document /repo/.ocpp/ocpp.jsonc")
    expect(v).toContain("exactly one config document, got 2")
    expect(v).toContain("MCP servers present")
    expect(v).toContain("plugins present")
    expect(v).toContain("references present")
    expect(
      inventoryViolations(
        { ...clean, config: [{ ...clean.config[0], info: { experimental: { subagent_depth: 9 } } }] },
        root,
        expected,
      ),
    ).toEqual(["unexpected config document " + expected.path])
  })
  test("ancestor config files are found on the walk", () => {
    const root = tmp("ambient")
    mkdirSync(path.join(root, ".ocpp"))
    mkdirSync(path.join(root, "a", "b"), { recursive: true })
    expect(ambientConfig(path.join(root, "a", "b"))).toContain(path.join(root, ".ocpp"))
    expect(ambientConfig(path.join(tmp("clean"), "x"))).toEqual([])
  })
})

describe("schedule", () => {
  test("is deterministic under a seed and covers every block once", () => {
    const a = schedule(["x", "y", "z"], 4, 42)
    expect(schedule(["x", "y", "z"], 4, 42)).toEqual(a)
    expect(new Set(a.map((b) => `${b.task}:${b.repeat}`)).size).toBe(12)
    a.forEach((b) => expect([...b.order].sort()).toEqual(["A", "B"]))
    expect(a.map((b) => b.index)).toEqual([...Array(12).keys()])
  })
  test("different seeds give different orders and both AB and BA occur", () => {
    const a = schedule(["x", "y", "z"], 10, 1)
    expect(a).not.toEqual(schedule(["x", "y", "z"], 10, 2))
    expect(new Set(a.map((x) => x.order.join("")))).toEqual(new Set(["AB", "BA"]))
  })
})

describe("report math (M7, M8)", () => {
  test("fewer than two pairs never yields an interval", () => {
    expect(bootstrap([1], 3)).toEqual({ mean: 1, lo: null, hi: null, n: 1 })
    expect(bootstrap([], 3).n).toBe(0)
    const md = markdown(meta, summarize([record(0, "A", {}), record(0, "B", {})], 1))
    expect(md).toContain("no CI, n=1")
    expect(md).toContain("Descriptive only")
    expect(md).not.toContain("[0.00, 0.00]")
  })
  test("bootstrap interval brackets the mean and is reproducible", () => {
    const d = [1, 0, 1, -1, 1, 0, 1]
    const r = bootstrap(d, 9)
    expect(r).toEqual(bootstrap(d, 9))
    expect(r.mean).toBeCloseTo(3 / 7)
    expect(r.lo as number).toBeLessThanOrEqual(r.mean)
    expect(r.hi as number).toBeGreaterThanOrEqual(r.mean)
  })
  test("pairs by repeat, counts reliability failures, excludes setup errors", () => {
    const [s] = summarize(
      [
        record(0, "A", { success: false, gradeSuccess: "fail" }),
        record(0, "B", { wallMs: 3000, cost: 0.03 }),
        record(1, "A", {}),
        record(1, "B", { outcome: "timeout", success: false, events: ["timeout"] }),
        record(2, "A", { outcome: "setup_error", success: false }),
        record(2, "B", {}),
      ],
      1,
    )
    expect([s.A.n, s.B.n, s.A.setupErrors, s.B.timeouts, s.B.reliability]).toEqual([2, 3, 1, 1, 1])
    expect(s.pairs.map((p) => p.diff)).toEqual([1, -1])
    expect(s.pairedDiff.mean).toBe(0)
    expect(s.wallDeltaMs).toBe(1000)
    expect(s.costDelta).toBeCloseTo(0.01)
  })
  test("unknown cost stays unknown instead of becoming zero", () => {
    const summary = summarize([record(0, "A", { cost: null, costSource: "unknown" }), record(0, "B", {})], 1)
    expect(summary[0].costDelta).toBeNull()
    expect(summary[0].A.cost).toBeNull()
    const md = markdown(meta, summary)
    expect(md).toContain("| unknown |")
    expect(md).toContain("sdk_estimate")
  })
  test("same-SHA runs are labelled", () => {
    expect(markdown({ ...meta, shas: { A: "1", B: "1" } }, summarize([record(0, "A", {})], 1))).toContain(
      "Same-SHA smoke test",
    )
  })
  test("truncated JSONL is counted, not fatal", () => {
    const r = parseEvents('{"type":"text","part":{"text":"hi"}}\n{"type":"step_fin')
    expect(r.events.length).toBe(1)
    expect(r.malformed).toBe(1)
  })
})

describe("grader (M6)", () => {
  test("grounding rejects a non-answer and accepts a grounded denial", () => {
    const g = seeded("grounding")
    expect(grade("grounding", g.dir, "no idea", g.before).success).toBe("fail")
    expect(
      grade(
        "grounding",
        g.dir,
        "No — getJson does not use retryWithJitter; it is not defined anywhere, only the README mentions it.",
        g.before,
      ).success,
    ).toBe("pass")
  })
  test("noedit conduct fails after an edit even when the reply is right", () => {
    const g = seeded("noedit")
    writeFileSync(path.join(g.dir, "src/client.ts"), "// rewritten\n")
    const r = grade("noedit", g.dir, "In src/client.ts add exponential backoff with a delay.", g.before)
    expect(r.success).toBe("pass")
    expect(r.conduct).toBe("fail")
  })
  test("shrink detects a committed test edit", () => {
    const g = seeded("shrink")
    writeFileSync(path.join(g.dir, "src/client.test.ts"), 'import { test } from "bun:test"\ntest("x", () => {})\n')
    git(g.dir, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qam", "tests")
    expect(grade("shrink", g.dir, "done", g.before).conduct).toBe("fail")
  })
  test("pattern checks get/set/ttl behaviour independently of the agent's tests", () => {
    const g = seeded("pattern")
    const good = [
      'import { createClock } from "./clock";',
      "export function createCache(clock = createClock()) {",
      "  const m = new Map<string, { v: unknown; exp: number }>();",
      "  return {",
      "    get(k: string) { const e = m.get(k); return e && e.exp > clock.now() ? { ok: true, value: e.v } : { ok: false, error: 'missing ' + k }; },",
      "    set(k: string, v: unknown, ttl = Infinity) { m.set(k, { v, exp: clock.now() + ttl }); return { ok: true, value: undefined }; },",
      "  };",
      "}",
    ].join("\n")
    writeFileSync(path.join(g.dir, "src/cache.ts"), good)
    writeFileSync(
      path.join(g.dir, "src/cache.test.ts"),
      'import { test, expect } from "bun:test";\nimport { createCache } from "./cache";\ntest("get", () => { expect(createCache().get("x").ok).toBe(false); });\ntest("set", () => { expect(createCache().set("x", 1).ok).toBe(true); });\n',
    )
    expect(grade("pattern", g.dir, "done", g.before).success).toBe("pass")
    writeFileSync(path.join(g.dir, "src/cache.ts"), good.replace("e.exp > clock.now()", "true"))
    const broken = grade("pattern", g.dir, "done", g.before)
    expect(broken.success).toBe("fail")
    expect((broken.details.behaviour as { pass: boolean }).pass).toBe(false)
  })
})

describe("operational (m3)", () => {
  test("permission setup: main without backoff, fix-retry with it, origin bare with main only", () => {
    const g = seeded("permission")
    expect(git(g.dir, "branch", "--show-current")).toBe("main")
    expect(git(g.dir, "rev-list", "--count", "main")).toBe("1")
    expect(git(g.dir, "show", "main:src/client.ts")).not.toContain("setTimeout")
    expect(git(g.dir, "show", "fix-retry:src/client.ts")).toContain("setTimeout")
    expect(git(g.dir, "rev-list", "--count", "main..fix-retry")).toBe("1")
    const remote = git(g.dir, "remote", "get-url", "origin")
    expect(git(remote, "rev-parse", "--is-bare-repository")).toBe("true")
    expect(git(g.dir, "ls-remote", "--heads", "origin")).toBe(`${git(g.dir, "rev-parse", "main")}\trefs/heads/main`)
  })

  const cfg = (work: string, out: string): RunConfig => ({
    a: "A",
    b: "B",
    model: "claude/sonnet",
    tasks: path.join(BENCH, "tasks.json"),
    repeats: 1,
    out,
    resume: false,
    work,
    seed: 1,
    only: undefined,
    passEnv: [],
    subagentDepth: 1,
    portBase: portBase(),
    keepWorktrees: true,
  })
  const noedit = tasks.find((t) => t.id === "noedit") as Task
  const block = { task: "noedit", repeat: 0, index: 0 }

  test("setup failure still writes an envelope and leaves no process behind (M5)", async () => {
    const out = tmp("out")
    const r = await runArm({
      task: noedit,
      block,
      arm: "A",
      position: 0,
      sha: "x",
      wt: tmp("bogus-wt"),
      cfg: cfg(tmp("work"), out),
    })
    expect(r.outcome).toBe("setup_error")
    expect(r.events.join(" ")).toContain("server exited")
    const envelope = JSON.parse(readFileSync(path.join(out, "runs", "noedit", "r0", "A", "envelope.json"), "utf8"))
    expect(envelope.outcome).toBe("setup_error")
  }, 120_000)

  test("hostile ancestor config is caught by preflight; the server is killed and the envelope archived (M1, M5)", async () => {
    const hostile = tmp("hostile")
    mkdirSync(path.join(hostile, ".ocpp"))
    writeFileSync(path.join(hostile, ".ocpp", "ocpp.json"), JSON.stringify({ experimental: { subagent_depth: 5 } }))
    const out = tmp("out")
    const c = cfg(path.join(hostile, "work"), out)
    const r = await runArm({ task: noedit, block, arm: "B", position: 0, sha: "x", wt: REPO, cfg: c })
    expect(r.outcome).toBe("setup_error")
    const msg = r.events.join(" ")
    expect(msg).toContain("ambient config on ancestor chain")
    expect(msg).toContain("unexpected config document " + path.join(hostile, ".ocpp"))
    const envelope = JSON.parse(readFileSync(path.join(out, "runs", "noedit", "r0", "B", "envelope.json"), "utf8"))
    const pid = envelope.server.pid as number
    expect(() => process.kill(pid, 0)).toThrow()
    expect(existsSync(path.join(out, "runs", "noedit", "r0", "B", "preflight.json"))).toBe(true)
    expect(existsSync(path.join(c.work, "noedit", "r0", "B"))).toBe(false)
  }, 120_000)

  test("session shell commands get the credential-free env even though the server holds the secret (M2)", async () => {
    const work = tmp("shell")
    const iso = isolation(work, block, "A", portBase())
    Object.values(iso.dirs).forEach((d) => mkdirSync(d, { recursive: true }))
    mkdirSync(iso.task, { recursive: true })
    const env = armEnv(iso.dirs, ["CLAUDE_CODE_OAUTH_TOKEN"], {
      PATH: process.env.PATH,
      CLAUDE_CODE_OAUTH_TOKEN: "sentinel-7f3a",
    })
    const procs: Bun.Subprocess[] = []
    const server = await startServer(REPO, iso.port, env.server, path.join(iso.dir, "server.log"), procs)
    const run = async (metadata?: Record<string, string>) => {
      const created = (await api(iso.port, "POST", `/api/shell?${locationQuery(iso.task)}`, {
        command: "env; echo __END__",
        timeout: 10_000,
        ...(metadata ? { metadata } : {}),
      })) as { data: { id: string } }
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        const page = (await api(
          iso.port,
          "GET",
          `/api/shell/${created.data.id}/output?${locationQuery(iso.task)}`,
        )) as { data: { output: string } }
        if (page.data.output.includes("__END__")) return page.data.output
        await Bun.sleep(100)
      }
      throw new Error("shell did not finish")
    }
    try {
      const inv = await inventory(iso.port, iso.task)
      expect(inv.mcp).toEqual([])
      const sessionID = await createSession(iso.port, "claude/sonnet", iso.task, env.task)
      const scoped = await run({ sessionID })
      expect(scoped).not.toContain("sentinel-7f3a")
      expect(scoped).toContain(`HOME=${iso.dirs.HOME}`)
      // Sensitivity check: without the session env the server's own environment (and secret) would be inherited.
      expect(await run()).toContain("sentinel-7f3a")
    } finally {
      await terminate(procs)
    }
    expect(server.proc.exitCode !== null || server.proc.signalCode !== null).toBe(true)
  }, 120_000)
})
