import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { bootstrap, isolation, schedule, summarize, validateManifest, type RunRecord } from "./paired"

const tasks = await Bun.file(path.join(import.meta.dir, "tasks.json")).json()

describe("manifest", () => {
  test("shipped manifest is valid and skips orch", () => {
    const parsed = validateManifest(tasks)
    expect(parsed.map((t) => t.id).sort()).toEqual(["grounding", "noedit", "pattern", "permission", "shrink"])
  })

  test("rejects duplicates, unknown fixtures, scenarios and deadlines", () => {
    const ok = tasks[0]
    expect(() => validateManifest([])).toThrow("non-empty")
    expect(() => validateManifest([ok, ok])).toThrow("duplicated")
    expect(() => validateManifest([{ ...ok, fixture: "nope" }])).toThrow("does not exist")
    expect(() => validateManifest([{ ...ok, scenario: "orch" }])).toThrow("scenario")
    expect(() => validateManifest([{ ...ok, deadlineSec: 0 }])).toThrow("deadlineSec")
    expect(() => validateManifest([{ ...ok, prompt: " " }])).toThrow("prompt")
  })
})

describe("isolation", () => {
  test("every arm and repeat gets distinct HOME/XDG/TMPDIR roots and ports", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "bench-iso-"))
    const blocks = schedule(["noedit", "grounding"], 3, 7)
    const all = blocks.flatMap((b) => (["A", "B"] as const).map((arm) => isolation(root, b, arm, 18081)))
    const ports = all.map((i) => i.port)
    expect(new Set(ports).size).toBe(all.length)
    expect(ports.every((p) => p >= 18081)).toBe(true)
    const keys = Object.keys(all[0].dirs)
    expect(keys.sort()).toEqual(["HOME", "TMPDIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"])
    keys.forEach((k) => expect(new Set(all.map((i) => (i.dirs as Record<string, string>)[k])).size).toBe(all.length))
    const home = os.homedir()
    all.forEach((i) => {
      Object.values(i.dirs).forEach((d) => expect(d.startsWith(root)).toBe(true))
      expect(i.db.startsWith(i.dirs.XDG_DATA_HOME)).toBe(true)
      expect(i.db.startsWith(path.join(home, ".local", "share"))).toBe(false)
      expect(i.task.startsWith(i.dir)).toBe(true)
    })
  })
})

describe("schedule", () => {
  test("is deterministic under a seed and covers every block once", () => {
    const a = schedule(["x", "y", "z"], 4, 42)
    expect(schedule(["x", "y", "z"], 4, 42)).toEqual(a)
    expect(a.length).toBe(12)
    expect(new Set(a.map((b) => `${b.task}:${b.repeat}`)).size).toBe(12)
    a.forEach((b) => expect([...b.order].sort()).toEqual(["A", "B"]))
    expect(a.map((b) => b.index)).toEqual([...Array(12).keys()])
  })

  test("different seeds give different orders and both AB and BA occur", () => {
    const a = schedule(["x", "y", "z"], 10, 1)
    const b = schedule(["x", "y", "z"], 10, 2)
    expect(a).not.toEqual(b)
    const orders = new Set(a.map((x) => x.order.join("")))
    expect(orders).toEqual(new Set(["AB", "BA"]))
  })
})

describe("report math", () => {
  test("bootstrap of constant differences collapses to the constant", () => {
    expect(bootstrap([1, 1, 1], 3)).toEqual({ mean: 1, lo: 1, hi: 1, n: 3 })
    expect(bootstrap([], 3).n).toBe(0)
  })

  test("bootstrap interval brackets the mean and is reproducible", () => {
    const d = [1, 0, 1, -1, 1, 0, 1]
    const r = bootstrap(d, 9)
    expect(r).toEqual(bootstrap(d, 9))
    expect(r.mean).toBeCloseTo(3 / 7)
    expect(r.lo).toBeLessThanOrEqual(r.mean)
    expect(r.hi).toBeGreaterThanOrEqual(r.mean)
    expect(r.lo).toBeGreaterThanOrEqual(-1)
    expect(r.hi).toBeLessThanOrEqual(1)
  })

  test("summarize pairs by repeat, counts reliability failures, excludes setup errors", () => {
    const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
    const run = (repeat: number, arm: "A" | "B", over: Partial<RunRecord>): RunRecord => ({
      task: "t", repeat, block: repeat, arm, position: arm === "A" ? 0 : 1, sha: arm, outcome: "ok", success: true,
      wallMs: 1000, tokens, cost: 0.01, cache: "cold", events: [], archive: "", ...over,
    })
    const runs = [
      run(0, "A", { success: false }),
      run(0, "B", { wallMs: 3000, cost: 0.03 }),
      run(1, "A", {}),
      run(1, "B", { outcome: "timeout", success: false, events: ["timeout"] }),
      run(2, "A", { outcome: "setup_error", success: false }),
      run(2, "B", {}),
    ]
    const [s] = summarize(runs, 1)
    expect(s.A.n).toBe(2)
    expect(s.B.n).toBe(3)
    expect(s.A.setupErrors).toBe(1)
    expect(s.B.timeouts).toBe(1)
    expect(s.B.reliability).toBe(1)
    expect(s.pairs.map((p) => p.diff)).toEqual([1, -1])
    expect(s.pairedDiff.mean).toBe(0)
    expect(s.wallDeltaMs).toBe(1000)
    expect(s.costDelta).toBeCloseTo(0.01)
    expect(s.B.events).toEqual(["timeout"])
  })
})
