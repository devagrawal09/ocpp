import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CodeMode, isToolHandle, Tool } from "../src/index.js"

const echo = Tool.make({
  description: "Echo a value",
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.Struct({ value: Schema.String }),
  execute: (input) => Effect.succeed(input),
})

const run = (code: string, bindings?: Readonly<Record<string, CodeMode.NotebookValue>>) =>
  Effect.runPromise(CodeMode.execute({ code, bindings, tools: { echo } }))

const declarations = async (code: string, bindings?: Readonly<Record<string, CodeMode.NotebookValue>>) => {
  const result = await run(code, bindings)
  if (!result.ok) throw new Error(result.error.message)
  return result.declarations
}

// A stored notebook always crosses JSON on its way to and from the host.
const restarted = (values: Readonly<Record<string, CodeMode.NotebookValue>>) =>
  JSON.parse(JSON.stringify(values)) as Record<string, CodeMode.NotebookValue>

describe("durable notebook declarations", () => {
  test("saves every direct top-level const and function without export syntax", async () => {
    const result = await run(`const response = tools.echo({ value: "ok" })
const answer = { value: response.value }
function describe(item) { return item.value }
return describe(answer)`)

    expect(result).toMatchObject({
      ok: true,
      value: "ok",
      toolCalls: [{ name: "echo" }],
    })
    if (!result.ok) return
    expect(Object.keys(result.declarations)).toEqual(["response", "answer", "describe"])
    expect(result.declarations.answer).toEqual({ value: "ok" })
  })

  test("keeps declarations nested in blocks, loops, and functions activation-local", async () => {
    expect(
      await declarations(`const kept = 1
{
  const hidden = 2
}
for (const item of [1]) {
  const looped = item
}
function outer() {
  const inner = 3
  return inner
}
if (kept === 1) {
  const branch = 4
}
return outer()`),
    ).toEqual({ kept: 1, outer: expect.anything() })
  })

  test("rejects export syntax and top-level destructuring with direct diagnostics", async () => {
    for (const code of [
      "export const value = 1",
      "export let value = 1",
      "export function value() {}",
      "export default 1",
    ]) {
      const result = await run(code)
      expect(result).toMatchObject({ ok: false, error: { kind: "UnsupportedSyntax" } })
      if (!result.ok) expect(result.error.message).toContain("export is not supported")
    }
    const destructured = await run("const { a } = { a: 1 }")
    expect(destructured).toMatchObject({ ok: false, error: { kind: "UnsupportedSyntax" } })
    if (!destructured.ok) expect(destructured.error.message).toContain("one durable name")

    const duplicated = await run("const value = 1\nfunction value() {}")
    expect(duplicated).toMatchObject({ ok: false, error: { kind: "ParseError" } })
    if (!duplicated.ok) expect(duplicated.error.message).toContain("already been declared")
  })

  test("saves closures with their exact captures, including recursion, across executions", async () => {
    const saved = await declarations(`const factor = 3
const scale = (value) => value * factor
function total(values) { return values.reduce((sum, value) => sum + scale(value), 0) }
function countdown(value) { return value <= 0 ? [] : [value, ...countdown(value - 1)] }`)

    const later = await run(
      `return { scaled: scale(2), total: total([1, 2]), countdown: countdown(3) }`,
      restarted(saved),
    )
    expect(later).toMatchObject({ ok: true, value: { scaled: 6, total: 9, countdown: [3, 2, 1] } })
  })

  test("binds captures when the execution saves and never re-reads a later notebook value", async () => {
    const saved = await declarations(`let counter = 1
const read = () => counter
counter = 2`)
    expect(await run("return read()", restarted(saved))).toMatchObject({ ok: true, value: 2 })

    const shadowed = await run("const read = () => 5\nreturn read()", restarted(saved))
    expect(shadowed).toMatchObject({ ok: true, value: 5 })
    // The saved closure keeps its own capture; the new declaration is a separate durable name.
    expect(await run("return read()", restarted(saved))).toMatchObject({ ok: true, value: 2 })
  })

  test("saved closures re-resolve and re-authorize tool paths in the execution that invokes them", async () => {
    const saved = await declarations(`const forward = (value) => tools.echo({ value }).value`)
    expect(await run(`return forward("through")`, restarted(saved))).toMatchObject({
      ok: true,
      value: "through",
      toolCalls: [{ name: "echo" }],
    })
    const withoutTools = await Effect.runPromise(
      CodeMode.execute({ code: `return forward("through")`, bindings: restarted(saved) }),
    )
    expect(withoutTools).toMatchObject({ ok: false, error: { kind: "UnknownTool" } })
  })

  test("saves nothing when the program fails after declaring values", async () => {
    const result = await run(`const early = tools.echo({ value: "kept" })
throw new Error("later failure")`)
    expect(result).toMatchObject({ ok: false, toolCalls: [{ name: "echo" }] })
    expect(result).not.toHaveProperty("declarations")
  })

  test("rejects a function that reads an identifier which does not exist when it is saved", async () => {
    const result = await run("const broken = () => missingLater")
    expect(result).toMatchObject({ ok: false, error: { kind: "InvalidDurableValue" } })
    if (!result.ok) expect(result.error.message).toContain("missingLater")
  })

  test("rejects live tool handles and reserved keys as durable values", async () => {
    const handle = await run(`const delegate = tool.define({
  name: "delegate",
  description: "Delegate",
  inputSchema: {},
  outputSchema: {},
  execute: (input) => input,
})`)
    expect(handle).toMatchObject({ ok: false, error: { kind: "UnsupportedSyntax" } })
    if (!handle.ok) expect(handle.error.message).toContain("activation-local")

    const wrapped = await run(`let handle = tool.define({
  name: "delegate",
  description: "Delegate",
  inputSchema: {},
  outputSchema: {},
  execute: (input) => input,
})
const saved = { handle }`)
    expect(wrapped).toMatchObject({ ok: false, error: { kind: "InvalidDurableValue" } })
    if (!wrapped.ok) expect(wrapped.error.message).toContain("live tool handle")

    const reserved = await run(`const value = { "$codemode": "function" }`)
    expect(reserved).toMatchObject({ ok: false, error: { kind: "InvalidDurableValue" } })
  })

  test("enforces the durable value size limit while the execution is still running", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `const big = "x".repeat(2000)`,
        limits: { maxDeclarationBytes: 512 },
      }),
    )
    expect(result).toMatchObject({ ok: false, error: { kind: "InvalidDurableValue" } })
    if (!result.ok) expect(result.error.message).toContain("durable value limit")
  })

  test("loads immutable saved data", async () => {
    expect(await declarations("const next = previous.map((value) => value * 2)", { previous: [1, 2] })).toEqual({
      next: [2, 4],
    })
  })

  test("passes same-execution tool handles with immutable captures", async () => {
    const delegate = Tool.make({
      description: "Invoke a delegated handle",
      input: Schema.Struct({ handle: Schema.Unknown, input: Schema.Unknown }),
      output: Schema.Unknown,
      acceptsToolHandles: true,
      execute: ({ handle, input }) =>
        isToolHandle(handle) ? handle.invoke(input) : Effect.fail(new Error("Expected a tool handle")),
    })
    const result = await Effect.runPromise(
      CodeMode.execute({
        tools: { echo, delegate },
        code: `let suffix = "!"
const state = { [Symbol.iterator]: () => suffix }
const readers = [() => suffix]
let decorate = tool.define({
  name: "decorate",
  description: "Decorate text",
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  execute: (input) => tools.echo({ value: input.value + state[Symbol.iterator]() + readers[0]() }),
})
suffix = "?"
return tools.delegate({ handle: decorate, input: { value: "ok" } })`,
      }),
    )

    expect(result).toMatchObject({
      ok: true,
      value: { value: "ok!!" },
      toolCalls: [{ name: "delegate" }, { name: "echo" }],
    })
  })

  test.each([
    ["other Promise APIs", "return Promise.race([])"],
    ["spread Promise.all", "const items = []; return Promise.all(...items)"],
    ["async", "const run = async () => 1; return run()"],
    ["generator", "function* values() { yield 1 }; return values()"],
    ["dynamic tools", "const name = 'echo'; return tools[name]({ value: 'x' })"],
    ["member assignment", "const value = {}; value.x = 1; return value"],
    ["for-of member assignment", "const value = {}; for (value.x of [1]) {}; return value"],
    ["array member destructuring", "const value = [0]; [value[0]] = [1]; return value"],
    ["object member destructuring", "const value = {}; ({ x: value.x } = { x: 1 }); return value"],
    ["mutating method", "const value = []; value.push(1); return value"],
  ])("rejects %s", async (_name, code) => {
    const result = await run(code)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("UnsupportedSyntax")
  })

  test("allows activation-local let and shares it with synchronous callbacks", async () => {
    expect(await run("let total = 1; total += 2; return total")).toMatchObject({ ok: true, value: 3 })
    expect(await run("let total = 0; [1, 2, 3].forEach((value) => { total += value }); return total")).toMatchObject({
      ok: true,
      value: 6,
    })
  })

  test.each([
    "const value = []; const method = 'push'; value[method](1); return value",
    "const value = {}; const method = 'assign'; Object[method](value, { changed: true }); return value",
  ])("rejects computed aggregate mutation: %s", async (code) => {
    const result = await run(code)
    expect(result).toMatchObject({ ok: false, error: { kind: "UnsupportedSyntax" } })
  })

  test.each([
    "time",
    "url",
    "console",
    "JSON",
    "Object",
    "Math",
    "Array",
    "tools",
    "tool",
    "String",
    "Error",
    "Infinity",
  ])("refuses '%s' as a permanent notebook name", async (name) => {
    const constant = await run(`const ${name} = 1`)
    expect(constant).toMatchObject({ ok: false, error: { kind: "UnsupportedSyntax" } })
    if (!constant.ok) expect(constant.error.message).toContain("runtime global")
    const declared = await run(`function ${name}() { return 1 }`)
    expect(declared).toMatchObject({ ok: false, error: { kind: "UnsupportedSyntax" } })
  })

  test("keeps nested names ordinary while the top level stays reserved", async () => {
    expect(
      await run(`function read() {
  const time = 5
  return time
}
return read()`),
    ).toMatchObject({ ok: true, value: 5 })
  })

  test("refuses a top-level return that would skip a later declaration", async () => {
    for (const code of [
      `return 1\nconst later = 2`,
      `const first = 1\nif (first === 1) { return "early" }\nconst later = 2`,
      `for (const item of [1]) { return item }\nfunction later() { return 1 }`,
    ]) {
      const result = await run(code)
      expect(result).toMatchObject({ ok: false, error: { kind: "UnsupportedSyntax" } })
      if (!result.ok) expect(result.error.message).toContain("would skip a durable declaration")
    }
  })

  test("keeps a final preview return and returns inside declared functions", async () => {
    expect(
      await run(`const value = 1
function pick(item) { if (item) { return "yes" } return "no" }
return pick(value)`),
    ).toMatchObject({ ok: true, value: "yes" })
    expect(await run(`if (true) { return "nothing declared" }`)).toMatchObject({ ok: true, value: "nothing declared" })
  })

  test("quarantines one broken stored value without stopping unrelated code", async () => {
    const broken = { $codemode: "function", version: 1, source: "() => 1" } as unknown as CodeMode.NotebookValue
    const bindings = { good: 2, broken, dependent: { $codemode: "reference", name: "broken" } } as unknown as Record<
      string,
      CodeMode.NotebookValue
    >

    expect(await run("const doubled = good * 2\nreturn doubled", bindings)).toMatchObject({ ok: true, value: 4 })

    const read = await run("return broken", bindings)
    expect(read).toMatchObject({ ok: false, error: { kind: "InvalidDurableValue" } })
    if (!read.ok) {
      expect(read.error.message).toContain("Notebook value 'broken' cannot be loaded")
      expect(read.error.suggestions?.join(" ")).toContain("permanent")
    }

    // A stored value that references the broken one fails the same way instead of loading garbage.
    const chained = await run("return dependent", bindings)
    expect(chained).toMatchObject({ ok: false, error: { kind: "InvalidDurableValue" } })
    if (!chained.ok) expect(chained.error.message).toContain("'broken'")

    // Capturing the quarantined binding cannot smuggle it into a new durable value.
    const captured = await run("const wrapper = () => broken", bindings)
    expect(captured).toMatchObject({ ok: false, error: { kind: "InvalidDurableValue" } })
  })

  test("rebuilds mutually recursive saved functions", async () => {
    const saved = await declarations(`function even(value) { return value === 0 ? true : odd(value - 1) }
function odd(value) { return value === 0 ? false : even(value - 1) }`)
    expect(await run("return [even(4), odd(4)]", restarted(saved))).toMatchObject({ ok: true, value: [true, false] })
  })

  test("keeps encoded declarations when the timeout only interrupts background work", async () => {
    const slow = Tool.make({
      description: "Settles later than the deadline and ignores interruption",
      input: Schema.Struct({}),
      output: Schema.String,
      execute: () => Effect.uninterruptible(Effect.as(Effect.sleep(600), "late")),
    })
    // Background work reaches the interpreter only through stored IR, because the compiler rejects
    // async syntax. Marking the declared function async reproduces such a persisted program.
    const program = CodeMode.compile(`function wait() { return tools.host.slow({}) }
const kept = { saved: true }
wait()
return "done"`)
    const declaration = program.body.body.find((node) => node.type === "FunctionDeclaration")
    if (!declaration) throw new Error("Expected a compiled function declaration")
    declaration.async = true

    const result = await Effect.runPromise(
      CodeMode.execute({ code: program.source, program, tools: { host: { slow } }, limits: { timeoutMs: 100 } }),
    )

    expect(result).toMatchObject({ ok: true, value: "done" })
    if (!result.ok) return
    expect(result.declarations.kept).toEqual({ saved: true })
    expect(result.warnings?.[0]).toMatchObject({ kind: "TimeoutExceeded" })
  })

  test("rejects unsupported compiled IR versions", async () => {
    const program = { ...CodeMode.compile("return 1"), version: 999 } as unknown as CodeMode.Program
    const result = await Effect.runPromise(CodeMode.execute({ code: program.source, program }))
    expect(result).toMatchObject({ ok: false, error: { kind: "ExecutionFailure" }, toolCalls: [] })
  })

  test("decodes persisted IR before the interpreter sees it", async () => {
    const compiled = CodeMode.compile("return 1")
    expect(CodeMode.decodeProgram(JSON.parse(JSON.stringify(compiled)))).toMatchObject({ ok: true })
    expect(CodeMode.decodeProgram({ ...compiled, body: { type: "Program" } })).toMatchObject({ ok: false })

    const damaged = { ...compiled, declarations: [7] } as unknown as CodeMode.Program
    const result = await Effect.runPromise(CodeMode.execute({ code: damaged.source, program: damaged }))
    expect(result).toMatchObject({ ok: false, error: { kind: "ExecutionFailure" }, toolCalls: [] })
  })
})

describe("durable value model", () => {
  test.each([
    ["Date", "return new Date()"],
    ["RegExp", "return new RegExp('a')"],
    ["regex literal", "return /a/g"],
    ["Map", "return new Map()"],
    ["Set", "return new Set([1])"],
    ["URL", "return new URL('https://a.dev')"],
    ["URLSearchParams", "return new URLSearchParams('a=1')"],
  ])("removes %s from the language", async (_name, code) => {
    const result = await run(code)
    expect(result).toMatchObject({ ok: false, error: { kind: "UnsupportedSyntax" } })
  })

  test("time helpers return numbers and strings", async () => {
    const result = await run(`const at = time.parse("2020-01-02T03:04:05.000Z")
return {
  at,
  formatted: time.format(at),
  parts: time.parts(at),
  tomorrow: time.format(time.add(at, { days: 1 })),
  elapsed: time.diff(at, 0),
  roundTrip: time.fromParts(time.parts(at)),
  invalid: time.parse("not a date"),
}`)
    expect(result).toMatchObject({
      ok: true,
      value: {
        at: 1577934245000,
        formatted: "2020-01-02T03:04:05.000Z",
        parts: { year: 2020, month: 1, day: 2, hour: 3, minute: 4, second: 5, millisecond: 0, weekday: 4 },
        tomorrow: "2020-01-03T03:04:05.000Z",
        elapsed: 1577934245000,
        roundTrip: 1577934245000,
        invalid: null,
      },
    })
  })

  test("url helpers return records, arrays, and strings", async () => {
    const result = await run(`const parsed = url.parse("https://example.dev/a/b?x=1&x=2#frag")
return {
  parsed,
  formatted: url.format({ scheme: "https", host: "example.dev", path: "/a", query: [{ name: "x", value: "1 2" }] }),
  query: url.parseQuery("?a=1&b=2"),
  encoded: url.encode("a b"),
  decoded: url.decode("a%20b"),
  invalid: url.parse("not a url"),
}`)
    expect(result).toMatchObject({
      ok: true,
      value: {
        parsed: {
          scheme: "https",
          host: "example.dev",
          path: "/a/b",
          query: [
            { name: "x", value: "1" },
            { name: "x", value: "2" },
          ],
          hash: "frag",
        },
        formatted: "https://example.dev/a?x=1+2",
        query: [
          { name: "a", value: "1" },
          { name: "b", value: "2" },
        ],
        encoded: "a%20b",
        decoded: "a b",
        invalid: null,
      },
    })
  })

  // No pattern engine here bounds its work by input length, so no partial matching is offered.
  test.each([
    ["the regex namespace", `return regex.test("^a+$", "aaa")`],
    ["a regex helper on a saved value", `const found = regex.match("a", "abc")`],
  ])("reports regular expressions as unavailable: %s", async (_name, code) => {
    const result = await run(code)
    expect(result).toMatchObject({ ok: false, error: { kind: "UnsupportedSyntax" } })
    if (!result.ok) expect(result.error.message).toContain("Regular expressions are not available")
  })

  test("matches text with string methods instead", async () => {
    expect(
      await run(`const line = "id-42 ok"
return { has: line.includes("id-"), id: line.slice(3, line.indexOf(" ")), parts: line.split(" ") }`),
    ).toMatchObject({ ok: true, value: { has: true, id: "42", parts: ["id-42", "ok"] } })
  })

  test("normalizes array holes and negative zero so storage round trips agree", async () => {
    const saved = await declarations(`const sparse = [1, , 3]
const zero = -0`)
    expect(saved).toEqual({ sparse: [1, null, 3], zero: 0 })
    expect(saved).toEqual(restarted(saved))
    expect(Object.is(saved.zero, 0)).toBe(true)
  })

  test("normalizes undefined to null and drops undefined record keys", async () => {
    const saved = await declarations(`function nothing() {}
const missing = nothing()
const items = [1, nothing(), 3]
const record = { kept: 1, gone: nothing() }`)
    expect(saved).toEqual({ nothing: expect.anything(), missing: null, items: [1, null, 3], record: { kept: 1 } })
    expect(saved).toEqual(restarted(saved))
  })
})
