import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Schema } from "effect"
import { CodeMode, Tool } from "../src/index.js"
import { MAX_UNWAITED_RUNS } from "../src/limits.js"

// A fresh set of tools per test, recording what they did so a test can see order and overlap.
const harness = () => {
  const events: Array<string> = []
  // Opens once two pair calls have started, so a pair only finishes when both run at the same time.
  const together = Deferred.makeUnsafe<void>()
  let paired = 0
  const task = Tool.make({
    description: "Run a task",
    input: Schema.Struct({ name: Schema.String, fail: Schema.optionalKey(Schema.Boolean) }),
    output: Schema.Struct({ name: Schema.String }),
    concurrent: true,
    execute: (input) =>
      Effect.gen(function* () {
        events.push("start " + input.name)
        if (input.fail === true) return yield* Effect.fail(new Error("task " + input.name + " failed"))
        yield* Effect.yieldNow
        events.push("end " + input.name)
        return { name: input.name }
      }),
  })
  const pair = Tool.make({
    description: "Run a task that needs its partner running",
    input: Schema.Struct({ name: Schema.String }),
    output: Schema.Struct({ name: Schema.String }),
    concurrent: true,
    execute: (input) =>
      Effect.gen(function* () {
        paired++
        if (paired === 2) yield* Deferred.succeed(together, undefined)
        yield* Deferred.await(together)
        return { name: input.name }
      }),
  })
  const echo = Tool.make({
    description: "Echo a value",
    input: Schema.Struct({ value: Schema.Unknown }),
    output: Schema.Unknown,
    execute: (input) => Effect.succeed(input.value),
  })
  const tools = { task, pair, echo }
  const run = (code: string) => Effect.runPromise(CodeMode.execute({ code, tools, limits: { timeoutMs: 5_000 } }))
  return { events, tools, run }
}

describe("concurrent tool runs", () => {
  test("a call returns a run at once, and wait() returns its result", async () => {
    const { run, events } = harness()
    const result = await run(`let started = tools.task({ name: "a" })
let before = typeof started
let value = started.wait()
return { before, value }`)
    expect(result).toMatchObject({ ok: true, value: { before: "object", value: { name: "a" } } })
    expect(events).toEqual(["start a", "end a"])
  })

  test("runs started before any wait run at the same time", async () => {
    const { run } = harness()
    const result = await run(`let first = tools.pair({ name: "a" })
let second = tools.pair({ name: "b" })
return [first.wait(), second.wait()]`)
    expect(result).toMatchObject({ ok: true, value: [{ name: "a" }, { name: "b" }] })
  })

  test("await resolves a run into a savable result", async () => {
    const { run } = harness()
    const result = await run(`const review = await tools.task({ name: "a" })
return review`)
    expect(result).toMatchObject({ ok: true, value: { name: "a" }, declarations: { review: { name: "a" } } })
  })

  test("Promise.all resolves overlapping runs and preserves plain values in order", async () => {
    const { run } = harness()
    const result = await run(`const reviews = await Promise.all([
  tools.pair({ name: "a" }), 42, tools.pair({ name: "b" }), null,
])
return reviews`)
    expect(result).toMatchObject({
      ok: true,
      value: [{ name: "a" }, 42, { name: "b" }, null],
      declarations: { reviews: [{ name: "a" }, 42, { name: "b" }, null] },
    })
    expect(await run("return Promise.all([])")).toMatchObject({ ok: true, value: [] })
    expect(
      await run(`let task = tools.task({ name: "once" })
return Promise.all([task, task])`),
    ).toMatchObject({ ok: true, value: [{ name: "once" }, { name: "once" }] })
  })

  test("await and Promise.all expose run failures to catch", async () => {
    const { run } = harness()
    for (const expression of [
      'await tools.task({ name: "x", fail: true })',
      'Promise.all([tools.task({ name: "x", fail: true }), tools.task({ name: "y", fail: true })])',
    ]) {
      const result = await run(`try {
  ${expression}
  return "no error"
} catch (error) {
  return error.message
}`)
      expect(result).toMatchObject({ ok: true, value: expect.stringContaining("failed") })
    }
  })

  test("returned runs are refused before joining unfinished work", async () => {
    for (const code of ["return tools.pending({})", "let run = tools.pending({}); return { runs: [run] }"]) {
      for (const evaluate of [false, true]) {
        let interrupted = false
        const pending = Tool.make({
          description: "Stay running until interrupted",
          input: Schema.Struct({}),
          output: Schema.Unknown,
          concurrent: true,
          execute: () =>
            Effect.never.pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true
                }),
              ),
            ),
        })
        const options = { code, tools: { pending }, limits: { timeoutMs: 500 } }
        const result = await Effect.runPromise(
          Effect.scoped(evaluate ? CodeMode.evaluate(options) : CodeMode.execute(options)),
        )
        expect(result).toMatchObject({ ok: false, error: { kind: "InvalidDataValue" } })
        expect(interrupted).toBe(true)
      }
    }
  })

  test("runs started from a callback can be waited on together", async () => {
    const { run } = harness()
    const result = await run(`let runs = ["a", "b"].map((name) => tools.pair({ name }))
return runs.map((run) => run.wait().name)`)
    expect(result).toMatchObject({ ok: true, value: ["a", "b"] })
  })

  test("calls are counted in program order, before their runs interleave", async () => {
    const { run } = harness()
    const result = await run(`let first = tools.pair({ name: "a" })
let second = tools.pair({ name: "b" })
first.wait()
second.wait()
return tools.echo({ value: 1 })`)
    expect(result.toolCalls.map((call) => call.name)).toEqual(["pair", "pair", "echo"])
  })

  test("wait() throws the call's error where the program can catch it", async () => {
    const { run } = harness()
    const result = await run(`let failing = tools.task({ name: "x", fail: true })
try {
  failing.wait()
  return "no error"
} catch (error) {
  return error.message
}`)
    expect(result).toMatchObject({ ok: true, value: expect.stringContaining("task x failed") })
  })

  test("waiting again returns the same outcome without running the call again", async () => {
    const { run, events } = harness()
    const result = await run(`let once = tools.task({ name: "a" })
return [once.wait(), once.wait()]`)
    expect(result).toMatchObject({ ok: true, value: [{ name: "a" }, { name: "a" }] })
    expect(events).toEqual(["start a", "end a"])
  })

  test("a run the program never waited on finishes before the execution settles", async () => {
    const { run, events } = harness()
    const result = await run(`tools.task({ name: "background" })
return "done"`)
    expect(result).toMatchObject({ ok: true, value: "done" })
    expect(events).toEqual(["start background", "end background"])
  })

  test("a run the program never waited on fails the execution with its error", async () => {
    const { run } = harness()
    const result = await run(`tools.task({ name: "x", fail: true })
const kept = 1`)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.message).toContain("task x failed")
  })

  test("a run is not data", async () => {
    const { run } = harness()
    const returned = await run(`return tools.task({ name: "a" })`)
    expect(returned).toMatchObject({ ok: false, error: { kind: "InvalidDataValue" } })
    if (!returned.ok) expect(returned.error.message).toContain("run of tools.task")

    const passed = await run(`let started = tools.task({ name: "a" })
return tools.echo({ value: started })`)
    expect(passed).toMatchObject({ ok: false, error: { kind: "InvalidDataValue" } })
    if (!passed.ok) expect(passed.error.message).toContain("call .wait()")

    const read = await run(`let started = tools.task({ name: "a" })
return started.name`)
    expect(read).toMatchObject({ ok: false, error: { kind: "InvalidDataValue" } })
    if (!read.ok) expect(read.error.message).toContain("its only member is wait()")
  })

  test("a saved name cannot hold a run, but can hold its result", async () => {
    const { run } = harness()
    const held = await run(`const review = tools.task({ name: "a" })`)
    expect(held).toMatchObject({ ok: false, error: { kind: "InvalidDataValue" } })
    if (!held.ok) expect(held.error.message).toContain("'review' would hold a run of tools.task")

    const nested = await run(`let started = tools.task({ name: "a" })
const reviews = [started]`)
    expect(nested).toMatchObject({ ok: false, error: { kind: "InvalidDataValue" } })

    const saved = await run(`let started = tools.task({ name: "a" })
const review = started.wait()`)
    expect(saved).toMatchObject({ ok: true, declarations: { review: { name: "a" } } })
  })

  test("a program may hold only a bounded number of runs it has not waited on", async () => {
    const { run } = harness()
    const result = await run(`let runs = []
for (let index = 0; index <= ${MAX_UNWAITED_RUNS}; index++) runs = [...runs, tools.task({ name: "t" + index })]
return runs.length`)
    expect(result).toMatchObject({ ok: false, error: { kind: "ToolCallLimitExceeded" } })
    // The refused call never started, so the host saw only the runs under the limit.
    expect(result.toolCalls).toHaveLength(MAX_UNWAITED_RUNS)

    const waited = await run(`let names = []
for (let index = 0; index <= ${MAX_UNWAITED_RUNS}; index++) names = [...names, tools.task({ name: "t" + index }).wait().name]
return names.length`)
    expect(waited).toMatchObject({ ok: true, value: MAX_UNWAITED_RUNS + 1 })
  })

  test("the signature shows that a call returns a run", () => {
    const { tools } = harness()
    const catalog = CodeMode.make({ tools }).catalog()
    expect(catalog.find((entry) => entry.path === "task")?.signature).toBe(
      "tools.task(input: {\n  name: string,\n  fail?: boolean,\n}): { wait(): {\n  name: string,\n} }",
    )
  })
})
