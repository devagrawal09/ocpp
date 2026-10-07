import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CodeMode, compile, Tool } from "../src/index.js"
import { plan } from "../src/speculation.js"

const planOf = (source: string) => plan(compile(source).body).statements

const summary = (source: string) =>
  planOf(source).map((statement) =>
    statement.opaque ? "opaque" : statement.calls.map((call) => call.path + "(" + call.reads.join(",") + ")"),
  )

describe("speculation plan", () => {
  test("lists each statement's direct tool calls, the argument, and the names it reads", () => {
    const statements = planOf(
      ['const a = tools.fs.read({ path: "a" })', "const b = tools.fs.read({ path: dir + a.name, limit })"].join("\n"),
    )
    expect(statements.map((statement) => statement.opaque)).toEqual([false, false])
    expect(statements[0]?.calls.map((call) => [call.statement, call.path, call.reads])).toEqual([[0, "fs.read", []]])
    expect(statements[1]?.calls.map((call) => [call.statement, call.path, call.reads])).toEqual([
      [1, "fs.read", ["dir", "a", "limit"]],
    ])
    expect(statements[1]?.calls[0]?.argument?.type).toBe("ObjectExpression")
  })

  test("orders calls as they run, arguments before the call that takes them", () => {
    expect(summary('tools.a.b({ inner: tools.c({ x: 1 }).id, other: tools["d.e"]({}) })')).toEqual([
      // The outer argument reads `tools` through the inner calls, which early evaluation refuses.
      ["c()", "d.e()", "a.b(tools)"],
    ])
  })

  test("marks statements opaque when they call user or notebook functions or methods", () => {
    expect(
      summary(["function helper() { return 1 }", "helper()", 'const x = tools.t.read({ k: "a" })'].join("\n")),
    ).toEqual([[], "opaque", ["t.read()"]])
    expect(summary('const lines = text.split("\\n")')).toEqual(["opaque"])
    expect(summary("const saved = savedNotebookFunction(1)")).toEqual(["opaque"])
    expect(summary("const xs = [1].map((x) => tools.t.read({ k: String(x) }))")).toEqual(["opaque"])
  })

  test("marks impure helpers opaque", () => {
    expect(summary(["const at = time.now()", "const r = Math.random()"].join("\n"))).toEqual(["opaque", "opaque"])
  })

  test("marks loops, conditional calls, iterators and unknown forms opaque", () => {
    expect(
      summary(
        [
          "for (const k of keys) tools.t.read({ k })",
          'const maybe = flag ? tools.t.read({ k: "a" }) : null',
          'const either = flag && tools.t.read({ k: "a" })',
          "let [first] = list",
          "const copy = [...list]",
          'if (flag) { tools.t.read({ k: "a" }) }',
          "try { x = 1 } catch {}",
          'const opt = tools.t.read?.({ k: "a" })',
          "const spread = tools.t.read(...args)",
        ].join("\n"),
      ),
    ).toEqual(Array.from({ length: 9 }, () => "opaque"))
  })

  test("keeps data-only statements, branches without calls, and function declarations transparent", () => {
    expect(
      summary(
        [
          "let count = 0",
          "const label = `${prefix}-${count + 1}`",
          'if (!label) throw new Error("missing")',
          "count = count + 1",
          "function later() { return tools.t.write({ k: 'x' }) }",
          "let { a, b: { c } } = record",
        ].join("\n"),
      ),
    ).toEqual([[], [], [], [], [], []])
    expect(planOf("count = count + 1")[0]?.writes).toEqual(["count"])
  })

  test("a call without exactly one argument has no argument to evaluate", () => {
    expect(planOf("tools.t.read()")[0]?.calls[0]?.argument).toBeUndefined()
    expect(planOf("tools.t.read({}, {})")[0]?.calls[0]?.argument).toBeUndefined()
  })
})

type Proposal = { readonly before: number; readonly calls: ReadonlyArray<CodeMode.ToolCallProposal> }

const makeTools = (ran: Array<string>) => ({
  t: {
    read: Tool.make({
      description: "Read",
      input: Schema.Struct({ k: Schema.String, limit: Schema.optional(Schema.Number) }),
      output: Schema.Struct({ v: Schema.String }),
      execute: (input: { readonly k: string }) =>
        Effect.sync(() => {
          ran.push("read:" + input.k)
          return { v: input.k + "!" }
        }),
    }),
    write: Tool.make({
      description: "Write",
      input: Schema.Struct({ k: Schema.String }),
      output: Schema.Struct({ ok: Schema.Boolean }),
      execute: (input: { readonly k: string }) =>
        Effect.sync(() => {
          ran.push("write:" + input.k)
          return { ok: true }
        }),
    }),
  },
})

/** Runs a program, recording every observable: result, tool calls, starts, traces, logs and impure reads. */
const observe = async (code: string, speculate: boolean, extra: Partial<CodeMode.ExecuteOptions> = {}) => {
  const ran: Array<string> = []
  const proposals: Array<Proposal> = []
  const starts: Array<unknown> = []
  const traces: Array<unknown> = []
  const impure: Array<string> = []
  let calls = 0
  const result = await Effect.runPromise(
    CodeMode.execute({
      code,
      tools: makeTools(ran),
      ...extra,
      onToolCallStart: (call) =>
        Effect.sync(() => {
          calls++
          starts.push(call)
        }),
      onTrace: (event) => Effect.sync(() => void traces.push(event)),
      impure: (helper) => {
        impure.push(helper)
        return impure.length
      },
      ...(speculate
        ? { onSpeculate: (offered) => Effect.sync(() => void proposals.push({ before: calls, calls: offered })) }
        : {}),
    }),
  )
  return { result, ran, proposals, starts, traces, impure }
}

describe("interpreter look-ahead", () => {
  test("proposes the calls the program makes next, decoded, with the index each will take", async () => {
    const { proposals, ran } = await observe(
      [
        'const a = tools.t.read({ k: "a" })',
        'const b = tools.t.read({ k: "b", limit: 2 })',
        "const c = tools.t.read({ k: a.v })",
      ].join("\n"),
      true,
    )
    expect(ran).toEqual(["read:a", "read:b", "read:a!"])
    expect(proposals).toEqual([
      // `a` is unset before the first statement runs, so the third call stops the window.
      {
        before: 0,
        calls: [
          { index: 0, name: "t.read", input: { k: "a" } },
          { index: 1, name: "t.read", input: { k: "b", limit: 2 } },
        ],
      },
      {
        before: 1,
        calls: [
          { index: 1, name: "t.read", input: { k: "b", limit: 2 } },
          { index: 2, name: "t.read", input: { k: "a!" } },
        ],
      },
      { before: 2, calls: [{ index: 2, name: "t.read", input: { k: "a!" } }] },
    ])
  })

  test("never looks past a statement that calls a user function or reads an impure helper", async () => {
    const helper = await observe(
      [
        'function helper() { return tools.t.write({ k: "w" }) }',
        'const a = tools.t.read({ k: "a" })',
        "helper()",
        'const b = tools.t.read({ k: "b" })',
      ].join("\n"),
      true,
    )
    expect(helper.proposals[0]).toEqual({ before: 0, calls: [{ index: 0, name: "t.read", input: { k: "a" } }] })
    expect(helper.proposals.flatMap((proposal) => proposal.calls).filter((call) => call.index === 2)).toEqual([
      { index: 2, name: "t.read", input: { k: "b" } },
    ])
    expect(helper.proposals.find((proposal) => proposal.calls.some((call) => call.index === 2))?.before).toBe(2)

    const clock = await observe(
      ['const a = tools.t.read({ k: "a" })', "const at = time.now()", 'const b = tools.t.read({ k: "b" })'].join("\n"),
      true,
    )
    expect(clock.proposals[0]?.calls.map((call) => call.index)).toEqual([0])
    expect(clock.impure).toEqual(["time.now"])
  })

  test("stops at a call whose argument reads a binding assigned earlier in the window", async () => {
    const { proposals } = await observe(['let k = "a"', 'k = "b"', "const x = tools.t.read({ k })"].join("\n"), true)
    // Until `k = "b"` has run, the call would read a value that is about to change, so the only
    // proposal comes right before the call's own statement.
    expect(proposals).toEqual([{ before: 0, calls: [{ index: 0, name: "t.read", input: { k: "b" } }] }])
  })

  test("refuses arguments that cannot be evaluated without side effects", async () => {
    const { proposals } = await observe(
      ['const a = tools.t.read({ k: "a" })', "const b = tools.t.read({ k: missing.value })"].join("\n"),
      true,
      { bindings: {} },
    ).catch(() => ({ proposals: [] as Array<Proposal> }))
    expect(proposals[0]?.calls.map((call) => call.index)).toEqual([0])
  })

  test("never proposes a call past maxToolCalls", async () => {
    const { proposals, result } = await observe(
      ['tools.t.read({ k: "a" })', 'tools.t.read({ k: "b" })', 'tools.t.read({ k: "c" })'].join("\n"),
      true,
      { limits: { maxToolCalls: 2 } },
    )
    expect(result.ok).toBe(false)
    expect(proposals.flatMap((proposal) => proposal.calls).every((call) => call.index < 2)).toBe(true)
  })

  test("speculation changes nothing the program or host observes", async () => {
    const programs = [
      ['const a = tools.t.read({ k: "a" })', 'const b = tools.t.read({ k: "b" })', "return [a, b]"].join("\n"),
      [
        "let n = 0",
        'const first = tools.t.read({ k: "x" + n })',
        "n = n + 1",
        "const second = tools.t.read({ k: `x${n}` })",
        'console.log("between", n)',
        'tools.t.write({ k: "w" })',
        'const third = tools.t.read({ k: "x" + n })',
        "const at = time.now()",
        "const fourth = tools.t.read({ k: String(at) })",
        "return { first, second, third, fourth }",
      ].join("\n"),
      [
        "function twice(k) { return [tools.t.read({ k }), tools.t.read({ k })] }",
        'const pair = twice("p")',
        'const same = tools.t.read({ k: "p" })',
        'if (same.v !== "p!") throw new Error("unexpected")',
        "const r = Math.random()",
        "same",
      ].join("\n"),
      ['const a = tools.t.read({ k: "a" })', "tools.t.read({ k: 1 })", 'const never = tools.t.read({ k: "z" })'].join(
        "\n",
      ),
    ]
    for (const code of programs) {
      const on = await observe(code, true)
      const off = await observe(code, false)
      expect(on.proposals.length).toBeGreaterThan(0)
      expect(on.result).toEqual(off.result)
      expect(on.ran).toEqual(off.ran)
      expect(on.starts).toEqual(off.starts)
      expect(on.traces).toEqual(off.traces)
      expect(on.impure).toEqual(off.impure)
    }
  })
})

describe("look-ahead work", () => {
  /** Tools whose inputs count every decode of each key, which happens right after early evaluation. */
  const counting = () => {
    const decodes = new Map<string, number>()
    const counted = Schema.String.check(
      Schema.makeFilter((value: string) => {
        decodes.set(value, (decodes.get(value) ?? 0) + 1)
        return true
      }),
    )
    const tools = {
      t: {
        read: Tool.make({
          description: "Read",
          input: Schema.Struct({ k: counted }),
          output: Schema.Struct({ v: Schema.String }),
          execute: (input: { readonly k: string }) => Effect.succeed({ v: input.k + "!" }),
        }),
        write: Tool.make({
          description: "Write",
          input: Schema.Struct({ k: counted }),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => Effect.succeed({ ok: true }),
        }),
      },
    }
    return { decodes, tools }
  }

  test("evaluates and decodes each proposed call at most once, and never a barrier's argument", async () => {
    const { decodes, tools } = counting()
    const proposals: Array<Proposal> = []
    let calls = 0
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: [
          'const a = tools.t.read({ k: "a" })',
          'const b = tools.t.read({ k: "b" })',
          "let n = 1",
          'const c = tools.t.read({ k: "c" })',
          'const d = tools.t.read({ k: "d" })',
          'tools.t.write({ k: "w" })',
          'const e = tools.t.read({ k: "e" })',
          'const f = tools.t.read({ k: "f" })',
        ].join("\n"),
        tools,
        onToolCallStart: () => Effect.sync(() => void calls++),
        speculatable: (path) => (path === "t.write" ? "barrier" : "speculate"),
        onSpeculate: (offered) => Effect.sync(() => void proposals.push({ before: calls, calls: offered })),
      }),
    )
    expect(result.ok).toBe(true)
    // One decode when proposed and one when the program makes the call, however often it is re-offered.
    expect(Object.fromEntries(decodes)).toEqual({ a: 2, b: 2, c: 2, d: 2, e: 2, f: 2, w: 1 })
    const offers = proposals.flatMap((proposal) => proposal.calls)
    expect(offers.filter((call) => call.index === 3).length).toBeGreaterThan(1)
    // Nothing at or past the write is proposed until the write has run.
    expect(offers.some((call) => call.name === "t.write")).toBe(false)
    expect(
      proposals
        .filter((proposal) => proposal.before <= 4)
        .flatMap((proposal) => proposal.calls.map((call) => call.index)),
    ).not.toContain(5)
  })

  test("a skip call takes its index without being proposed", async () => {
    const proposals: Array<Proposal> = []
    await Effect.runPromise(
      CodeMode.execute({
        code: ['const found = tools.search({ query: "read" })', 'const a = tools.t.read({ k: "a" })'].join("\n"),
        tools: makeTools([]),
        speculatable: (path) => (path === "search" ? "skip" : "speculate"),
        onSpeculate: (offered) => Effect.sync(() => void proposals.push({ before: 0, calls: offered })),
      }),
    )
    expect(proposals[0]?.calls).toEqual([{ index: 1, name: "t.read", input: { k: "a" } }])
  })

  test("ends the window at a call that passes a notebook reference", async () => {
    const proposals: Array<Proposal> = []
    let calls = 0
    const inspect = Tool.make({
      description: "Inspect a direct reference",
      notebookReference: "value",
      input: Schema.Struct({ value: Schema.String }),
      output: Schema.String,
      execute: (input) => Effect.succeed(input.value),
    })
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: [
          'const a = tools.t.read({ k: "a" })',
          "const seen = tools.nb.inspect({ value: label })",
          'const b = tools.t.read({ k: "b" })',
        ].join("\n"),
        bindings: { label: "a saved string" },
        tools: { ...makeTools([]), nb: { inspect } },
        onToolCallStart: () => Effect.sync(() => void calls++),
        onSpeculate: (offered) => Effect.sync(() => void proposals.push({ before: calls, calls: offered })),
      }),
    )
    // The real call sends the saved name, which early evaluation of the value could never match.
    expect(result).toMatchObject({ ok: true, declarations: { seen: "label" } })
    expect(proposals.flatMap((proposal) => proposal.calls).some((call) => call.name === "nb.inspect")).toBe(false)
    expect(proposals[0]).toEqual({ before: 0, calls: [{ index: 0, name: "t.read", input: { k: "a" } }] })
    expect(proposals.find((proposal) => proposal.calls.some((call) => call.index === 2))?.before).toBe(2)
  })
})
