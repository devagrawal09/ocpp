import path from "node:path"

const fixtures = [
  {
    name: "query-values",
    files: {
      "query.ts": `export function query(text: string): Record<string, string> {
  return Object.fromEntries(text.split("&").filter(Boolean).map((part) => {
    const [key, value = ""] = part.split("=")
    return [decodeURIComponent(key), decodeURIComponent(value)]
  }))
}
`,
      "query.test.ts": `import { expect, test } from "bun:test"
import { query } from "./query"
test("ordinary values and last duplicate win", () => {
  expect(query("a=1&b=2&a=3")).toEqual({ a: "3", b: "2" })
})
test("embedded equals survive", () => {
  expect(query("token=a=b=c")).toEqual({ token: "a=b=c" })
})
test("form plus and percent escapes", () => {
  expect(query("first+name=Ada+Lovelace&literal=%2B")).toEqual({ "first name": "Ada Lovelace", literal: "+" })
})
test("empty input and empty values", () => {
  expect(query("")).toEqual({})
  expect(query("flag&empty=")).toEqual({ flag: "", empty: "" })
})
`,
    },
  },
  {
    name: "config-defaults",
    files: {
      "defaults.ts": `export const defaults = { retries: 3, enabled: true, label: "default" }
export function fallback<T>(value: T | undefined, standard: T): T {
  return value || standard
}
`,
      "config.ts": `import { defaults, fallback } from "./defaults"
export function config(input: Partial<typeof defaults>) {
  return {
    retries: fallback(input.retries, defaults.retries),
    enabled: fallback(input.enabled, defaults.enabled),
    label: fallback(input.label, defaults.label),
  }
}
`,
      "config.test.ts": `import { expect, test } from "bun:test"
import { config } from "./config"
test("defaults for omitted values", () => {
  expect(config({})).toEqual({ retries: 3, enabled: true, label: "default" })
})
test("explicit falsy values are preserved", () => {
  expect(config({ retries: 0, enabled: false, label: "" })).toEqual({ retries: 0, enabled: false, label: "" })
})
test("non-default values and input immutability", () => {
  const input = Object.freeze({ retries: 7, label: "custom" })
  expect(config(input)).toEqual({ retries: 7, enabled: true, label: "custom" })
  expect(input).toEqual({ retries: 7, label: "custom" })
})
`,
    },
  },
  {
    name: "cache-recovery",
    files: {
      "cache.ts": `export function cache<T>(load: (key: string) => Promise<T>) {
  const pending = new Map<string, Promise<T>>()
  return (key: string) => {
    const previous = pending.get(key)
    if (previous) return previous
    const result = load(key)
    pending.set(key, result)
    return result
  }
}
`,
      "cache.test.ts": `import { expect, test } from "bun:test"
import { cache } from "./cache"
test("coalesces concurrent requests and retains successes", async () => {
  let calls = 0
  const get = cache(async (key) => { calls++; return key.toUpperCase() })
  const first = get("a")
  expect(get("a")).toBe(first)
  expect(await first).toBe("A")
  expect(await get("a")).toBe("A")
  expect(calls).toBe(1)
})
test("failed requests are evicted so retry can succeed", async () => {
  let calls = 0
  const get = cache(async () => {
    calls++
    if (calls === 1) throw new Error("temporary")
    return 42
  })
  await expect(get("a")).rejects.toThrow("temporary")
  expect(await get("a")).toBe(42)
  expect(calls).toBe(2)
})
test("keys are independent", async () => {
  const get = cache(async (key) => key)
  expect(await get("a")).toBe("a")
  expect(await get("b")).toBe("b")
})
`,
    },
  },
]

const root = process.argv[3]
if (!root || !path.isAbsolute(root)) throw new Error("Pass prepare|verify and a fresh absolute scratch path")
if (!["prepare", "verify"].includes(process.argv[2])) throw new Error("Unknown operation")
if (process.argv[2] === "prepare") {
  if (await Bun.file(path.join(root, "manifest.json")).exists()) throw new Error("Workspace already prepared")
  const runs = await Promise.all(
    fixtures.flatMap((fixture) =>
      [1, 2, 3].map(async (repeat) => {
        const workspace = path.join(root, fixture.name + "-" + repeat)
        await Promise.all(
          Object.entries(fixture.files).map(([name, content]) => Bun.write(path.join(workspace, name), content)),
        )
        const child = Bun.spawn(["bun", "test"], { cwd: workspace, stdout: "pipe", stderr: "pipe" })
        const [exit, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        if (exit === 0) throw new Error("Fixture must initially fail: " + workspace)
        return {
          name: fixture.name,
          repeat,
          workspace,
          files: fixture.files,
          baseline: { exit, output: stdout + stderr },
        }
      }),
    ),
  )
  await Bun.write(path.join(root, "manifest.json"), JSON.stringify({ runs }, null, 2))
  console.log(
    JSON.stringify({
      root,
      runs: runs.map((run) => ({ name: run.name, repeat: run.repeat, exit: run.baseline.exit })),
    }),
  )
}
if (process.argv[2] === "verify") {
  const manifest = (await Bun.file(path.join(root, "manifest.json")).json()) as {
    runs: { name: string; repeat: number; workspace: string; files: Record<string, string> }[]
  }
  const runs = await Promise.all(
    manifest.runs.map(async (run) => {
      const integrity = await Promise.all(
        Object.entries(run.files)
          .filter(([name]) => name.endsWith(".test.ts"))
          .map(async ([name, content]) => (await Bun.file(path.join(run.workspace, name)).text()) === content),
      )
      const child = Bun.spawn(["bun", "test"], { cwd: run.workspace, stdout: "pipe", stderr: "pipe" })
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      const trace = (await Bun.file(path.join(root, "trace-" + run.name + "-" + run.repeat + ".json")).json()) as {
        reason: string
        elapsedMs: number
        trace: {
          decision: { usage: { input_tokens: number; output_tokens: number } }
          outcomes: { id: string; state?: { source?: string; error?: unknown } }[]
        }[]
      }
      return {
        name: run.name,
        repeat: run.repeat,
        exit,
        testsUnchanged: integrity.every(Boolean),
        output: stdout + stderr,
        reason: trace.reason,
        elapsedMs: trace.elapsedMs,
        steps: trace.trace.length,
        generations: trace.trace.flatMap((step) =>
          step.outcomes.filter((entry) => entry.id === "factory" && entry.state?.source),
        ).length,
        errors: trace.trace.flatMap((step) =>
          step.outcomes.flatMap((entry) => (entry.state?.error ? [entry.state.error] : [])),
        ),
        decisionTokens: {
          input: trace.trace.reduce((total, step) => total + step.decision.usage.input_tokens, 0),
          output: trace.trace.reduce((total, step) => total + step.decision.usage.output_tokens, 0),
        },
      }
    }),
  )
  await Bun.write(path.join(root, "verification.json"), JSON.stringify({ runs }, null, 2))
  console.log(
    JSON.stringify({
      runs: runs.map(({ output, errors, ...run }) => ({ ...run, errors: errors.length })),
      passed: runs.filter((run) => run.exit === 0 && run.testsUnchanged).length,
      total: runs.length,
    }),
  )
}
