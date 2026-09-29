import { describe, expect, test } from "bun:test"
import { Cause, Effect, Schema } from "effect"
import { CodeMode, Tool, toolError } from "../src/index.js"

const run = (tool: Tool.Tool<never>) =>
  Effect.runPromise(CodeMode.make({ tools: { host: { call: tool } } }).execute("return tools.host.call({})"))

class HostError extends Schema.TaggedError<HostError>()("HostError", {
  message: Schema.String,
}) {}

describe("CodeMode host failure boundary", () => {
  test("preserves explicit tool failures", async () => {
    const result = await run(
      Tool.make({
        description: "Fail",
        input: Schema.Struct({}),
        output: Schema.String,
        execute: () => Effect.fail(toolError("Authorized request was refused")),
      }),
    )

    expect(result.ok ? undefined : result.error).toStrictEqual({
      kind: "ToolFailure",
      message: "Authorized request was refused",
    })
  })

  test("does not rewrite explicit tool failures", async () => {
    const result = await run(
      Tool.make({
        description: "Fail",
        input: Schema.Struct({}),
        output: Schema.String,
        execute: () => Effect.fail(toolError("File not found: /tmp/report.json")),
      }),
    )

    expect(result.ok ? undefined : result.error).toStrictEqual({
      kind: "ToolFailure",
      message: "File not found: /tmp/report.json",
    })
  })

  test("reports failures, defects, rejected Promises, and nested causes", async () => {
    for (const failure of [
      Effect.fail(new HostError({ message: "Connection refused" })),
      Effect.die(new Error("Connection refused")),
      Effect.promise(async () => {
        throw new Error("Connection refused")
      }),
      Effect.fail(toolError("Request failed", new Error("Connection refused"))),
      Effect.failCause(Cause.combine(Cause.fail("Request failed"), Cause.die("Connection refused"))),
    ]) {
      const result = await run(
        Tool.make({
          description: "Fail internally",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () => failure,
        }),
      )

      expect(result.ok ? undefined : result.error).toStrictEqual({
        kind: "ToolFailure",
        message: expect.stringContaining("Connection refused"),
      })
    }
  })

  test("reports invalid host output", async () => {
    const result = await run(
      Tool.make({
        description: "Return invalid output",
        input: Schema.Struct({}),
        output: Schema.Struct({ value: Schema.String }),
        execute: () => Effect.succeed({ value: 1 } as unknown as { readonly value: string }),
      }),
    )

    expect(result.ok ? undefined : result.error).toStrictEqual({
      kind: "InvalidToolOutput",
      message: "Invalid output from tool 'host.call': SchemaError(Expected string\n  at [\"value\"])",
    })
  })

  test("reports host output copying errors", async () => {
    const result = await run(
      Tool.make({
        description: "Return hostile output",
        input: Schema.Struct({}),
        output: Schema.Unknown,
        execute: () =>
          Effect.succeed(
            new Proxy(
              {},
              {
                ownKeys: () => {
                  throw new Error("Cannot enumerate output")
                },
              },
            ),
          ),
      }),
    )

    expect(result.ok ? undefined : result.error).toStrictEqual({
      kind: "InvalidToolOutput",
      message: "Invalid output from tool 'host.call': Error: Cannot enumerate output",
    })
  })

  test("caught tool failures are Error values in-program", async () => {
    const result = await Effect.runPromise(
      CodeMode.make({
        tools: {
          host: {
            call: Tool.make({
              description: "Refuse",
              input: Schema.Struct({}),
              output: Schema.String,
              execute: () => Effect.fail(toolError("Refused")),
            }),
          },
        },
      }).execute(`
        try {
          tools.host.call({})
          return "no"
        } catch (e) {
          return { isError: e instanceof Error, message: e.message }
        }
      `),
    )

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toStrictEqual({ isError: true, message: "Refused" })
  })

  test("propagates host interruption instead of returning a diagnostic", async () => {
    const exit = await Effect.runPromiseExit(
      CodeMode.make({
        tools: {
          host: {
            call: Tool.make({
              description: "Interrupt",
              input: Schema.Struct({}),
              output: Schema.String,
              execute: () => Effect.interrupt,
            }),
          },
        },
      }).execute("return tools.host.call({})"),
    )

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    }
  })
})

describe("CodeMode semantic tracing", () => {
  test("reports assignments, array summaries, branches, logs, and returns in order", async () => {
    const events: Array<CodeMode.TraceEvent> = []
    const result = await Effect.runPromise(
      CodeMode.execute({
        code:
          "const values = [1, 2, 3, 4]\n" +
          "const active = values.filter((value) => value > 2)\n" +
          "if (active.length > 1) console.log('active', active.length)\n" +
          "return active.reduce((total, value) => total + value, 0)",
        onTrace: (event) => Effect.sync(() => events.push(event)),
      }),
    )

    expect(result.ok).toBe(true)
    expect(events).toStrictEqual([
      { kind: "assignment", target: "values", value: "[1, 2, 3, 4] (4 items)" },
      { kind: "operation", operation: "filter", input: "4 items", output: "2 items" },
      { kind: "assignment", target: "active", value: "[3, 4] (2 items)" },
      { kind: "branch", expression: "active.length > 1", result: true },
      { kind: "log", method: "log", message: "active 2" },
      { kind: "operation", operation: "reduce", input: "2 items", output: "7" },
      { kind: "return", value: "7" },
    ])
  })
})

describe("CodeMode callback tracing", () => {
  test("traces direct helpers without expanding callback assignments", async () => {
    const events: Array<CodeMode.TraceEvent> = []
    const result = await Effect.runPromise(
      CodeMode.execute({
        code:
          "function select(values) {\n" +
          "  const mapped = values.map((value) => {\n" +
          "    const doubled = value * 2\n" +
          "    console.info('item', value)\n" +
          "    return doubled\n" +
          "  })\n" +
          "  return mapped\n" +
          "}\n" +
          "const result = select([1, 2])\n" +
          "return result",
        onTrace: (event) => Effect.sync(() => events.push(event)),
      }),
    )

    expect(result.ok).toBe(true)
    expect(events).toStrictEqual([
      { kind: "log", method: "info", message: "item 1" },
      { kind: "log", method: "info", message: "item 2" },
      { kind: "operation", operation: "map", input: "2 items", output: "2 items" },
      { kind: "assignment", target: "mapped", value: "[2, 4] (2 items)" },
      { kind: "assignment", target: "result", value: "[2, 4] (2 items)" },
      { kind: "return", value: "[2, 4] (2 items)" },
    ])
  })
})

describe("CodeMode impure helpers", () => {
  const program = `
    const started = time.now()
    const rolls = [1, 2].map(() => Math.random())
    const picked = [0].map(Math.random)
    return { started, rolls, picked, later: time.now() - started }
  `

  test("reads every impure value from the host hook in program order", async () => {
    const reads: Array<CodeMode.ImpureHelper> = []
    const values = [1_700_000_000_000, 0.25, 0.5, 0.75, 1_700_000_000_042]
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: program,
        impure: (helper) => {
          reads.push(helper)
          return values[reads.length - 1]
        },
      }),
    )

    expect(reads).toEqual(["time.now", "Math.random", "Math.random", "Math.random", "time.now"])
    expect(result).toMatchObject({
      ok: true,
      value: { started: 1_700_000_000_000, rolls: [0.25, 0.5], picked: [0.75], later: 42 },
    })
  })

  test("replaying recorded values reproduces the same result", async () => {
    const recorded: Array<number> = []
    const first = await Effect.runPromise(
      CodeMode.execute({
        code: program,
        impure: (helper) => {
          const value = helper === "time.now" ? Date.now() : Math.random()
          recorded.push(value)
          return value
        },
      }),
    )
    const replayed = [...recorded]
    const second = await Effect.runPromise(CodeMode.execute({ code: program, impure: () => replayed.shift() ?? 0 }))

    expect(replayed).toEqual([])
    expect(second).toEqual(first)
  })

  test("defaults to the host clock and random source", async () => {
    const before = Date.now()
    const result = await Effect.runPromise(CodeMode.execute({ code: "return [time.now(), Math.random()]" }))
    if (!result.ok || !Array.isArray(result.value)) throw new Error("Expected an array result")
    expect(result.value[0]).toBeGreaterThanOrEqual(before)
    expect(result.value[1]).toBeGreaterThanOrEqual(0)
    expect(result.value[1]).toBeLessThan(1)
  })
})

describe("CodeMode tool-call observation", () => {
  test("reports the tools actually invoked with decoded input", async () => {
    const calls: Array<unknown> = []
    const lookup = Tool.make({
      description: "Look up a value",
      input: Schema.Struct({ query: Schema.String }),
      output: Schema.String,
      execute: ({ query }) => Effect.succeed(query),
    })

    const result = await Effect.runPromise(
      CodeMode.make({
        tools: { context: { lookup } },
        onToolCallStart: (call) => Effect.sync(() => calls.push(call)),
      }).execute(`
        if (false) tools.context.lookup({ query: "not called" })
        return tools.context.lookup({ query: "deployment failure" })
      `),
    )

    expect(result.ok).toBe(true)
    expect(calls).toStrictEqual([{ index: 0, name: "context.lookup", input: { query: "deployment failure" } }])
  })

  test("observes settled calls with outcome and duration", async () => {
    const events: Array<{ phase: string; index: number; name: string; outcome?: string; message?: string }> = []
    const lookup = Tool.make({
      description: "Look up a value",
      input: Schema.Struct({ query: Schema.String }),
      output: Schema.String,
      execute: ({ query }) =>
        query === "boom"
          ? Effect.fail(toolError("Lookup refused"))
          : query === "defect"
            ? Effect.die("broken")
            : Effect.succeed(query),
    })

    const runtime = CodeMode.make({
      tools: { context: { lookup } },
      onToolCallStart: (call) =>
        Effect.sync(() => {
          events.push({ phase: "start", index: call.index, name: call.name })
        }),
      onToolCallEnd: (call) =>
        Effect.sync(() => {
          expect(call.durationMs).toBeGreaterThanOrEqual(0)
          events.push({
            phase: "end",
            index: call.index,
            name: call.name,
            outcome: call.outcome,
            ...(call.message === undefined ? {} : { message: call.message }),
          })
        }),
    })

    const success = await Effect.runPromise(runtime.execute(`return tools.context.lookup({ query: "ok" })`))
    expect(success.ok).toBe(true)
    const failure = await Effect.runPromise(runtime.execute(`return tools.context.lookup({ query: "boom" })`))
    expect(failure.ok).toBe(false)
    const defect = await Effect.runPromise(runtime.execute(`return tools.context.lookup({ query: "defect" })`))
    expect(defect.ok).toBe(false)

    expect(events).toStrictEqual([
      { phase: "start", index: 0, name: "context.lookup" },
      { phase: "end", index: 0, name: "context.lookup", outcome: "success" },
      { phase: "start", index: 0, name: "context.lookup" },
      { phase: "end", index: 0, name: "context.lookup", outcome: "failure", message: "Lookup refused" },
      { phase: "start", index: 0, name: "context.lookup" },
      { phase: "end", index: 0, name: "context.lookup", outcome: "failure", message: "broken" },
    ])
  })

  test("observes interrupted calls", async () => {
    const events: Array<string> = []
    const call = Tool.make({
      description: "Interrupt",
      input: Schema.Struct({}),
      output: Schema.String,
      execute: () => Effect.interrupt,
    })
    const exit = await Effect.runPromiseExit(
      CodeMode.make({
        tools: { host: { call } },
        onToolCallStart: () => Effect.sync(() => events.push("start")),
        onToolCallEnd: (call) => Effect.sync(() => events.push(`end:${call.outcome}`)),
      }).execute("return tools.host.call({})"),
    )

    expect(exit._tag).toBe("Failure")
    expect(events).toEqual(["start", "end:interrupted"])
  })

  test("ends calls interrupted during start observation", async () => {
    const events: Array<string> = []
    const call = Tool.make({
      description: "Unused",
      input: Schema.Struct({}),
      output: Schema.String,
      execute: () => Effect.succeed("unused"),
    })
    const exit = await Effect.runPromiseExit(
      CodeMode.make({
        tools: { host: { call } },
        onToolCallStart: () => Effect.interrupt,
        onToolCallEnd: (call) => Effect.sync(() => events.push(call.outcome)),
      }).execute("return tools.host.call({})"),
    )

    expect(exit._tag).toBe("Failure")
    expect(events).toEqual(["interrupted"])
  })

  test("observes calls interrupted by the execution timeout", async () => {
    const outcomes: Array<string> = []
    const call = Tool.make({
      description: "Pending",
      input: Schema.Struct({}),
      output: Schema.String,
      execute: () => Effect.never,
    })
    const result = await Effect.runPromise(
      CodeMode.make({
        tools: { host: { call } },
        limits: { timeoutMs: 10 },
        onToolCallEnd: (call) => Effect.sync(() => outcomes.push(call.outcome)),
      }).execute("return tools.host.call({})"),
    )

    expect(result).toMatchObject({ ok: false, error: { kind: "TimeoutExceeded" } })
    expect(outcomes).toEqual(["interrupted"])
  })
})

describe("CodeMode console capture", () => {
  test("captures console output as bounded result logs", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `
        const returned = console.log("Thread info:", { name: "Demo", count: 2 })
        console.warn("careful")
        return returned
      `,
      }),
    )

    expect(result).toStrictEqual({
      ok: true,
      value: null,
      declarations: { returned: null },
      logs: ['Thread info: {"name":"Demo","count":2}', "[warn] careful"],
      toolCalls: [],
    })
    expect(Schema.decodeUnknownSync(CodeMode.Result)(JSON.parse(JSON.stringify(result)))).toStrictEqual(result)
  })

  test("keeps logs captured before failures", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `
        console.log("before failure")
        throw new Error("boom")
      `,
      }),
    )

    expect(result.ok ? undefined : result.logs).toStrictEqual(["before failure"])
    expect(result.ok ? undefined : result.error.message).toBe("Uncaught: boom")
  })

  test("prints NaN and Infinity literally instead of the JSON null", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `
        console.log(NaN)
        console.log(Infinity, -Infinity)
        console.log({ ratio: NaN, bounds: [Infinity] })
        return null
      `,
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.logs).toStrictEqual(["NaN", "Infinity -Infinity", '{"ratio":NaN,"bounds":[Infinity]}'])
  })

  test("renders nested plain data inside logged containers", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `
        console.log({ entries: [["a", 1]], when: time.format(0), pattern: "ab" })
        console.log([time.format(0)])
        return null
      `,
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.logs).toStrictEqual([
      '{"entries":[["a",1]],"when":"1970-01-01T00:00:00.000Z","pattern":"ab"}',
      '["1970-01-01T00:00:00.000Z"]',
    ])
  })

  test("console formatting renders opaque references as markers", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `
        console.log({ fn: (x) => x, ok: 1 })
        return null
      `,
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.logs).toStrictEqual(['{"fn":[opaque reference],"ok":1}'])
  })

  test("console.table renders plain cells", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `
        console.table([{ when: time.format(0), n: NaN }])
        return null
      `,
      }),
    )

    expect(result.ok).toBe(true)
    expect(result.logs).toStrictEqual(["(index)\twhen\tn\n0\t1970-01-01T00:00:00.000Z\tNaN"])
  })

  test("captures console.dir and console.table output", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `
        console.dir({ nested: { ok: true } })
        console.table([
          { name: "Kit", count: 1, hidden: "x" },
          { name: "Olive", count: 2, hidden: "y" }
        ], ["name", "count"])
        return "done"
      `,
      }),
    )

    expect(result).toStrictEqual({
      ok: true,
      value: "done",
      declarations: {},
      logs: ['{"nested":{"ok":true}}', "(index)\tname\tcount\n0\tKit\t1\n1\tOlive\t2"],
      toolCalls: [],
    })
  })

  test("captures console.debug with its level prefix", async () => {
    const result = await Effect.runPromise(CodeMode.execute({ code: `console.debug("trace", 1); return null` }))

    expect(result.ok).toBe(true)
    expect(result.logs).toStrictEqual(["[debug] trace 1"])
  })
})

describe("CodeMode output budget", () => {
  test("absent maxOutputBytes means no truncation at all", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `console.log("z".repeat(50_000)); return "x".repeat(100_000)`,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.truncated).toBeUndefined()
    expect(result.value).toBe("x".repeat(100_000))
    expect(result.logs).toStrictEqual(["z".repeat(50_000)])
  })

  test("truncates an oversized result value with a marker instead of failing", async () => {
    const limits: CodeMode.ExecutionLimits = { maxOutputBytes: 40 }
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `return { data: "${"x".repeat(200)}" }`,
        limits,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.truncated).toBe(true)
    expect(typeof result.value).toBe("string")
    expect(result.value).toMatch(
      /^\{"data":"x+ \[result truncated: \d+ bytes exceeds the 40-byte output limit; return a smaller value\]$/,
    )
    expect(Schema.decodeUnknownSync(CodeMode.Result)(JSON.parse(JSON.stringify(result)))).toStrictEqual(result)
  })

  test("keeps leading logs within the remaining budget and marks the cut", async () => {
    const limits: CodeMode.ExecutionLimits = { maxOutputBytes: 40 }
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `
        console.log("first line")
        console.log("${"y".repeat(200)}")
        return "ok"
      `,
        limits,
      }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toBe("ok")
    expect(result.truncated).toBe(true)
    expect(result.logs).toStrictEqual(["first line", "[logs truncated: showing 1 of 2 lines]"])
  })

  test("does not mark results within the budget", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `
        console.log("fits")
        return { fits: true }
      `,
      }),
    )
    expect(result).toStrictEqual({
      ok: true,
      value: { fits: true },
      declarations: {},
      logs: ["fits"],
      toolCalls: [],
    })
  })
})

describe("CodeMode schema flexibility", () => {
  test("accepts render-only JSON Schema input and omitted output", async () => {
    const observed: Array<unknown> = []
    const call = Tool.make({
      description: "Call an adapter-described tool",
      input: {
        type: "object",
        properties: { id: { type: "string" }, count: { type: "number" } },
        required: ["id"],
      },
      execute: (input) =>
        Effect.sync(() => {
          observed.push(input)
          return { echoed: input }
        }),
    })
    const runtime = CodeMode.make({ tools: { adapter: { call } } })

    expect(runtime.catalog()).toStrictEqual([
      {
        path: "adapter.call",
        description: "Call an adapter-described tool",
        signature: "tools.adapter.call(input: {\n  id: string,\n  count?: number,\n}): void",
      },
    ])

    // JSON Schema is render-only: mistyped input passes through unvalidated.
    const result = await Effect.runPromise(runtime.execute(`return tools.adapter.call({ id: 42 })`))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBeNull()
    expect(observed).toStrictEqual([{ id: 42 }])
  })

  test("outbound tool arguments follow JSON serialization semantics", async () => {
    const observed: Array<unknown> = []
    const call = Tool.make({
      description: "Observe raw input",
      input: { type: "object" },
      execute: (input) =>
        Effect.sync(() => {
          observed.push(input)
          return "ok"
        }),
    })
    const runtime = CodeMode.make({ tools: { adapter: { call } } })

    const result = await Effect.runPromise(
      runtime.execute(
        `return tools.adapter.call({ q: undefined, limit: 0 / 0, rate: 1 / 0, items: [1, undefined, 2], holes: [1, , 3] })`,
      ),
    )
    expect(result.ok).toBe(true)
    const received = observed[0] as Record<string, unknown>
    expect(received).toStrictEqual({ limit: null, rate: null, items: [1, null, 2], holes: [1, null, 3] })
    // The undefined-valued property is dropped like JSON.stringify, not delivered as undefined.
    expect(Object.hasOwn(received, "q")).toBe(false)
  })

  test("dropping undefined values lets optionalKey schemas accept conditional arguments", async () => {
    const observed: Array<unknown> = []
    const find = Tool.make({
      description: "Find things",
      input: Schema.Struct({ query: Schema.optionalKey(Schema.String), limit: Schema.optionalKey(Schema.Number) }),
      execute: (input) =>
        Effect.sync(() => {
          observed.push(input)
          return "ok"
        }),
    })
    const runtime = CodeMode.make({ tools: { things: { find } } })

    // The `cond ? value : undefined` idiom: optionalKey rejects a present undefined, so the
    // JSON boundary must drop the key before the schema decodes.
    const result = await Effect.runPromise(runtime.execute(`return tools.things.find({ query: undefined, limit: 5 })`))
    expect(result.ok).toBe(true)
    expect(observed).toStrictEqual([{ limit: 5 }])

    const search = await Effect.runPromise(runtime.execute(`return tools.search({ query: undefined }).items.length`))
    expect(search.ok).toBe(true)
  })

  test("renders JSON Schema outputs and $defs references", async () => {
    const lookup = Tool.make({
      description: "Look up a user",
      input: { type: "object", properties: { login: { type: "string" } }, required: ["login"] },
      output: {
        $ref: "#/$defs/User",
        $defs: {
          User: {
            type: "object",
            properties: { login: { type: "string" }, id: { type: "number" } },
            required: ["login", "id"],
          },
        },
      },
      execute: () => Effect.succeed({ login: "kit", id: 7 }),
    })
    const runtime = CodeMode.make({ tools: { users: { lookup } } })

    expect(runtime.catalog()).toStrictEqual([
      {
        path: "users.lookup",
        description: "Look up a user",
        signature: "tools.users.lookup(input: {\n  login: string,\n}): {\n  login: string,\n  id: number,\n}",
      },
    ])

    const result = await Effect.runPromise(runtime.execute(`return tools.users.lookup({ login: "kit" })`))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toStrictEqual({ login: "kit", id: 7 })
  })

  test("Effect Schema output without an input transform renders void when omitted", async () => {
    const ping = Tool.make({
      description: "Ping",
      input: Schema.Struct({ host: Schema.String }),
      execute: () => Effect.succeed("pong"),
    })
    const runtime = CodeMode.make({ tools: { net: { ping } } })
    expect(runtime.catalog()[0]?.signature).toBe("tools.net.ping(input: {\n  host: string,\n}): void")

    const result = await Effect.runPromise(runtime.execute(`return tools.net.ping({ host: "example.test" })`))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toBeNull()
  })
})

describe("CodeMode public contract", () => {
  const lookup = Tool.make({
    description: "Look up an order by ID",
    input: Schema.Struct({ id: Schema.String }),
    output: Schema.Struct({ id: Schema.String, status: Schema.String }),
    execute: ({ id }) => Effect.succeed({ id, status: "open" }),
  })
  const tools = { orders: { lookup } }
  const source = `return tools.orders.lookup({ id: "order_42" })`

  test("keeps one-shot and reusable execution equivalent", async () => {
    const runtime = CodeMode.make({ tools })
    const [oneShot, reusable] = await Promise.all([
      Effect.runPromise(CodeMode.execute({ tools, code: source })),
      Effect.runPromise(runtime.execute(source)),
    ])

    expect(reusable).toStrictEqual(oneShot)
    const input: CodeMode.Input = { code: source }
    expect(Schema.decodeUnknownSync(CodeMode.Input)(input)).toStrictEqual(input)
    expect(Schema.decodeUnknownSync(CodeMode.Result)(JSON.parse(JSON.stringify(reusable)))).toStrictEqual(reusable)
  })

  test("accepts await as a synchronous compatibility no-op and warns once", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({ tools, code: `const order = await tools.orders.lookup({ id: "order_42" }); return await order` }),
    )

    expect(result).toStrictEqual({
      ok: true,
      value: { id: "order_42", status: "open" },
      declarations: { order: { id: "order_42", status: "open" } },
      warnings: [
        {
          kind: "Compatibility",
          message:
            "await was ignored for compatibility. Do not use it: operations within a script are semantically synchronous. Only execution of the script as a whole is asynchronous to the model.",
        },
      ],
      toolCalls: [{ name: "orders.lookup" }],
    })
  })

  test("serializes Promise.all for compatibility and warns once", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        tools,
        code: `return Promise.all([tools.orders.lookup({ id: "first" }), tools.orders.lookup({ id: "second" })])`,
      }),
    )

    expect(result).toStrictEqual({
      ok: true,
      value: [
        { id: "first", status: "open" },
        { id: "second", status: "open" },
      ],
      declarations: {},
      warnings: [
        {
          kind: "Compatibility",
          message:
            "Promise.all was serialized for compatibility. Do not use it: operations within a script are semantically synchronous, so array entries already run in order.",
        },
      ],
      toolCalls: [{ name: "orders.lookup" }, { name: "orders.lookup" }],
    })
  })

  test("a reused execution Effect starts from a clean slate", async () => {
    const echo = Tool.make({
      description: "echo",
      input: Schema.Struct({}),
      output: Schema.Number,
      execute: () => Effect.succeed(1),
    })
    const effect = CodeMode.execute({
      tools: { host: { echo } },
      code: `console.log("hi"); return tools.host.echo({})`,
      limits: { maxToolCalls: 1 },
    })
    const first = await Effect.runPromise(effect)
    const second = await Effect.runPromise(effect)
    // Per-execution state (tool-call budget and audit list, logs, timeout bookkeeping) must
    // bind at run time, so the second run neither exhausts the budget nor leaks run 1's logs.
    expect(first).toStrictEqual(second)
    expect(second).toStrictEqual({
      ok: true,
      value: 1,
      declarations: {},
      logs: ["hi"],
      toolCalls: [{ name: "host.echo" }],
    })
  })

  test("describes the catalog and keeps the search built-in registered", async () => {
    const runtime = CodeMode.make({ tools })
    expect(runtime.catalog()).toStrictEqual([
      {
        path: "orders.lookup",
        description: "Look up an order by ID",
        signature: "tools.orders.lookup(input: {\n  id: string,\n}): {\n  id: string,\n  status: string,\n}",
      },
    ])

    const result = await Effect.runPromise(runtime.execute(`return tools.search({ query: "order" })`))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toStrictEqual({
        items: [
          {
            path: "tools.orders.lookup",
            description: "Look up an order by ID",
            signature: "tools.orders.lookup(input: {\n  id: string,\n}): {\n  id: string,\n  status: string,\n}",
          },
        ],
        remaining: 0,
        next: null,
      })
    }
  })

  test("renders equivalent catalogs identically regardless of tool insertion order", () => {
    const alpha = Tool.make({
      description: "Alpha tool",
      input: Schema.Struct({}),
      output: Schema.Void,
      execute: () => Effect.void,
    })
    const zeta = Tool.make({
      description: "Zeta tool",
      input: Schema.Struct({}),
      output: Schema.Void,
      execute: () => Effect.void,
    })
    const first = CodeMode.make({ tools: { zeta: { zeta, alpha }, alpha: { zeta, alpha } } })
    const second = CodeMode.make({ tools: { alpha: { alpha, zeta }, zeta: { alpha, zeta } } })

    expect(first.catalog()).toStrictEqual(second.catalog())
    expect(first.catalog().map((tool) => tool.path)).toEqual(["alpha.alpha", "alpha.zeta", "zeta.alpha", "zeta.zeta"])
  })

  test("renders bracket notation for tool names that are not JavaScript identifiers", async () => {
    const resolveLibrary = Tool.make({
      description: "Resolve a library ID",
      input: Schema.Struct({ libraryName: Schema.String }),
      output: Schema.String,
      execute: ({ libraryName }) => Effect.succeed(`/resolved/${libraryName}`),
    })
    const runtime = CodeMode.make({ tools: { context7: { "resolve-library-id": resolveLibrary } } })

    expect(runtime.catalog()).toStrictEqual([
      {
        path: "context7.resolve-library-id",
        description: "Resolve a library ID",
        signature: 'tools.context7["resolve-library-id"](input: {\n  libraryName: string,\n}): string',
      },
    ])

    const search = await Effect.runPromise(runtime.execute(`return tools.search({ query: "resolve library id" })`))
    expect(search.ok).toBe(true)
    if (search.ok) {
      expect(search.value).toStrictEqual({
        items: [
          {
            path: 'tools.context7["resolve-library-id"]',
            description: "Resolve a library ID",
            signature: 'tools.context7["resolve-library-id"](input: {\n  libraryName: string,\n}): string',
          },
        ],
        remaining: 0,
        next: null,
      })
    }

    const call = await Effect.runPromise(
      runtime.execute(`return tools.context7["resolve-library-id"]({ libraryName: "TypeScript" })`),
    )
    expect(call.ok).toBe(true)
    if (call.ok) expect(call.value).toBe("/resolved/TypeScript")

    const exact = await Effect.runPromise(
      runtime.execute(`return tools.search({ query: 'tools.context7["resolve-library-id"]' })`),
    )
    expect(exact.ok).toBe(true)
    if (exact.ok) expect(exact.value).toMatchObject({ remaining: 0, next: null })
  })

  test("uses one ranked search returning complete tools for large catalogs", async () => {
    const upload = Tool.make({
      description: "Upload one readable local file to the current Discord thread",
      input: Schema.Struct({ path: Schema.String }),
      output: Schema.Struct({ sent: Schema.Boolean }),
      execute: () => Effect.succeed({ sent: true }),
    })
    const generate = Tool.make({
      description: "Generate an image and upload it to the current Discord thread",
      input: Schema.Struct({ prompt: Schema.String }),
      output: Schema.Struct({ sent: Schema.Boolean }),
      execute: () => Effect.succeed({ sent: true }),
    })
    const runtime = CodeMode.make({
      tools: { thread: { uploadFile: upload, generateImage: generate }, orders: { lookup } },
    })

    const result = await Effect.runPromise(
      runtime.execute(`
      return tools.search({
        query: "send message attachment upload file to current Discord thread",
        limit: 2
      })
    `),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toStrictEqual({
      items: [
        {
          path: "tools.thread.uploadFile",
          description: "Upload one readable local file to the current Discord thread",
          signature: "tools.thread.uploadFile(input: {\n  path: string,\n}): {\n  sent: boolean,\n}",
        },
        {
          path: "tools.thread.generateImage",
          description: "Generate an image and upload it to the current Discord thread",
          signature: "tools.thread.generateImage(input: {\n  prompt: string,\n}): {\n  sent: boolean,\n}",
        },
      ],
      remaining: 0,
      next: null,
    })
    expect(result.toolCalls).toStrictEqual([{ name: "search" }])

    const variants = await Effect.runPromise(
      runtime.execute(`
      return [
        tools.search({ query: "file" }),
        tools.search({ query: "image" })
      ]
    `),
    )
    expect(variants.ok).toBe(true)
    if (variants.ok) {
      expect((variants.value as Array<{ items: Array<{ path: string }> }>)[0]?.items[0]?.path).toBe(
        "tools.thread.uploadFile",
      )
      expect((variants.value as Array<{ items: Array<{ path: string }> }>)[1]?.items[0]?.path).toBe(
        "tools.thread.generateImage",
      )
    }
  })

  test("search is a counted tool call: it burns maxToolCalls and fires the hooks", async () => {
    const started: Array<string> = []
    const ended: Array<string> = []
    const limited = CodeMode.make({
      tools,
      limits: { maxToolCalls: 1 },
      onToolCallStart: (call) => Effect.sync(() => void started.push(call.name)),
      onToolCallEnd: (call) => Effect.sync(() => void ended.push(`${call.name}:${call.outcome}`)),
    })
    const result = await Effect.runPromise(limited.execute(`tools.search({}); return tools.search({})`))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("ToolCallLimitExceeded")
    expect(started).toEqual(["search"])
    expect(ended).toEqual(["search:success"])
  })

  test("search is available only through tools", async () => {
    const runtime = CodeMode.make({ tools })
    expect(await Effect.runPromise(runtime.execute(`return typeof search`))).toMatchObject({ value: "undefined" })
  })

  test("search defaults to 10 results and resolves exact tool paths", async () => {
    const tool = (index: number) =>
      Tool.make({
        description: `Numbered tool ${index}`,
        input: Schema.Struct({ id: Schema.String }),
        output: Schema.String,
        execute: () => Effect.succeed("ok"),
      })
    const runtime = CodeMode.make({
      tools: {
        many: Object.fromEntries(Array.from({ length: 14 }, (_, index) => [`tool${index}`, tool(index)])),
      },
    })

    const browse = await Effect.runPromise(runtime.execute(`return tools.search({})`))
    expect(browse.ok).toBe(true)
    if (browse.ok) {
      const value = browse.value as {
        items: Array<{ path: string }>
        remaining: number
        next: { offset: number } | null
      }
      expect(value.items).toHaveLength(10)
      expect(value.remaining).toBe(4)
      expect(value.next).toStrictEqual({ offset: 10 })
    }

    for (const query of ["many.tool13", "tools.many.tool13"]) {
      const exact = await Effect.runPromise(runtime.execute(`return tools.search({ query: ${JSON.stringify(query)} })`))
      expect(exact.ok).toBe(true)
      if (exact.ok) {
        expect(exact.value).toStrictEqual({
          items: [
            {
              path: "tools.many.tool13",
              description: "Numbered tool 13",
              signature: "tools.many.tool13(input: {\n  id: string,\n}): string",
            },
          ],
          remaining: 0,
          next: null,
        })
      }
    }
  })

  test("scopes search to one namespace and browses it alphabetically", async () => {
    const simple = (description: string) =>
      Tool.make({
        description,
        input: Schema.Struct({ id: Schema.String }),
        output: Schema.String,
        execute: () => Effect.succeed("ok"),
      })
    const runtime = CodeMode.make({
      tools: {
        github: { list_issues: simple("List issues"), create_issue: simple("Create an issue") },
        linear: { list_issues: simple("List Linear issues") },
      },
    })

    // Empty query + namespace browses just that namespace, alphabetical by path.
    const browse = await Effect.runPromise(runtime.execute(`return tools.search({ query: "", namespace: "github" })`))
    expect(browse.ok).toBe(true)
    if (browse.ok) {
      const value = browse.value as { items: Array<{ path: string }>; remaining: number }
      expect(value.remaining).toBe(0)
      expect(value.items.map((item) => item.path)).toStrictEqual([
        "tools.github.create_issue",
        "tools.github.list_issues",
      ])
    }

    // A query + namespace ranks within that namespace only.
    const scoped = await Effect.runPromise(runtime.execute(`return tools.search({ query: "issues", namespace: "linear" })`))
    expect(scoped.ok).toBe(true)
    if (scoped.ok) {
      const value = scoped.value as { items: Array<{ path: string }>; remaining: number }
      expect(value.remaining).toBe(0)
      expect(value.items[0]?.path).toBe("tools.linear.list_issues")
    }

    const invalid = await Effect.runPromise(runtime.execute(`return tools.search({ query: "issues", namespace: 7 })`))
    expect(invalid.ok).toBe(false)
    if (!invalid.ok) expect(invalid.error.kind).toBe("InvalidToolInput")
  })

  test("matches input parameter names and partial-word substrings", async () => {
    const upload = Tool.make({
      description: "Send a document to the workspace",
      input: {
        type: "object",
        properties: { attachment: { type: "string", description: "Local path of the payload to send" } },
        required: ["attachment"],
      },
      execute: () => Effect.succeed("ok"),
    })
    const other = Tool.make({
      description: "Rename the workspace",
      input: Schema.Struct({ name: Schema.String }),
      output: Schema.String,
      execute: () => Effect.succeed("ok"),
    })
    const runtime = CodeMode.make({ tools: { files: { upload, other } } })

    // "attachment" appears in neither path nor description - only in the input schema's
    // property names, which the searchable text includes.
    const byParameter = await Effect.runPromise(runtime.execute(`return tools.search({ query: "attachment" })`))
    expect(byParameter.ok).toBe(true)
    if (byParameter.ok) {
      const value = byParameter.value as { items: Array<{ path: string }>; remaining: number }
      expect(value.remaining).toBe(0)
      expect(value.items[0]?.path).toBe("tools.files.upload")
    }

    // Substring matching: a partial word ("docum") still hits the description.
    const bySubstring = await Effect.runPromise(runtime.execute(`return tools.search({ query: "docum" })`))
    expect(bySubstring.ok).toBe(true)
    if (bySubstring.ok) {
      const value = bySubstring.value as { items: Array<{ path: string }>; remaining: number }
      expect(value.remaining).toBe(0)
      expect(value.items[0]?.path).toBe("tools.files.upload")
    }
  })

  test("a plural query term matches singular-only tool text", async () => {
    const simple = (description: string) =>
      Tool.make({
        description,
        input: Schema.Struct({ id: Schema.String }),
        output: Schema.String,
        execute: () => Effect.succeed("ok"),
      })
    const runtime = CodeMode.make({
      tools: {
        // Neither path nor description contains "issues" - only the singular "issue".
        tracker: { fetch_all: simple("Fetch every open issue in the project") },
        github: { list_issues: simple("List issues") },
        misc: { rename: simple("Rename the workspace") },
      },
    })

    // "issues" still finds the singular-only tool (term OR singular(term) per field)...
    const plural = await Effect.runPromise(runtime.execute(`return tools.search({ query: "issues", namespace: "tracker" })`))
    expect(plural.ok).toBe(true)
    if (plural.ok) {
      const value = plural.value as { items: Array<{ path: string }>; remaining: number }
      expect(value.remaining).toBe(0)
      expect(value.items[0]?.path).toBe("tools.tracker.fetch_all")
    }

    // ...while a true "issues" path match still outranks the singular-only description match.
    const ranked = await Effect.runPromise(runtime.execute(`return tools.search({ query: "issues" })`))
    expect(ranked.ok).toBe(true)
    if (ranked.ok) {
      const value = ranked.value as { items: Array<{ path: string }>; remaining: number }
      expect(value.remaining).toBe(0)
      expect(value.items.map((item) => item.path)).toStrictEqual([
        "tools.github.list_issues",
        "tools.tracker.fetch_all",
      ])
    }
  })

  test("empty query lists everything alphabetically by path", async () => {
    const simple = (description: string) =>
      Tool.make({
        description,
        input: Schema.Struct({}),
        output: Schema.String,
        execute: () => Effect.succeed("ok"),
      })
    // Deliberately declared out of alphabetical order.
    const runtime = CodeMode.make({
      tools: {
        zeta: { last: simple("Last") },
        alpha: { beta: simple("Middle"), aardvark: simple("First") },
      },
    })
    const browse = await Effect.runPromise(runtime.execute(`return tools.search({})`))
    expect(browse.ok).toBe(true)
    if (browse.ok) {
      const value = browse.value as { items: Array<{ path: string }>; remaining: number; next: unknown }
      expect(value.items.map((item) => item.path)).toStrictEqual([
        "tools.alpha.aardvark",
        "tools.alpha.beta",
        "tools.zeta.last",
      ])
      expect(value.remaining).toBe(0)
      expect(value.next).toBeNull()
    }

    const middle = await Effect.runPromise(runtime.execute(`return tools.search({ limit: 1, offset: 1 })`))
    expect(middle.ok).toBe(true)
    if (middle.ok) {
      expect(middle.value).toMatchObject({
        items: [{ path: "tools.alpha.beta" }],
        remaining: 1,
        next: { offset: 2 },
      })
    }

    const exhausted = await Effect.runPromise(runtime.execute(`return tools.search({ limit: 1, offset: 3 })`))
    expect(exhausted.ok).toBe(true)
    if (exhausted.ok) expect(exhausted.value).toStrictEqual({ items: [], remaining: 0, next: null })
  })

  test("decodes tool input and output before exposing either side", async () => {
    const observed: Array<unknown> = []
    const transformed = Tool.make({
      description: "Double a number",
      input: Schema.Struct({ value: Schema.NumberFromString }),
      output: Schema.NumberFromString,
      execute: ({ value }) =>
        Effect.sync(() => {
          observed.push(value)
          return String(value * 2)
        }),
    })
    const runtime = CodeMode.make({
      tools: { math: { double: transformed } },
      onToolCallStart: (call) => Effect.sync(() => observed.push(call.input)),
    })

    const success = await Effect.runPromise(runtime.execute(`return tools.math.double({ value: "21" })`))
    expect(success).toStrictEqual({
      ok: true,
      value: 42,
      declarations: {},
      toolCalls: [{ name: "math.double" }],
    })
    expect(observed).toStrictEqual([{ value: 21 }, 21])

    const invalid = await Effect.runPromise(runtime.execute(`return tools.math.double({ value: 21 })`))
    expect(invalid.ok).toBe(false)
    if (invalid.ok) return
    expect(invalid.error.kind).toBe("InvalidToolInput")
    expect(observed).toStrictEqual([{ value: 21 }, 21])
  })

  test("returns JSON-safe data and normalizes undefined to null", async () => {
    const result = await Effect.runPromise(
      CodeMode.execute({
        code: `return { top: undefined, nested: [1, undefined] }`,
      }),
    )
    expect(result).toStrictEqual({
      ok: true,
      value: { top: null, nested: [1, null] },
      declarations: {},
      toolCalls: [],
    })
    expect(Schema.decodeUnknownSync(CodeMode.Result)(JSON.parse(JSON.stringify(result)))).toStrictEqual(result)
  })

  test("returns the final top-level expression when return is omitted", async () => {
    const result = await Effect.runPromise(CodeMode.execute({ code: `1; 2` }))

    expect(result).toStrictEqual({ ok: true, value: 2, declarations: {}, toolCalls: [] })
  })

  test("does not implicitly return expressions nested in control flow", async () => {
    const result = await Effect.runPromise(CodeMode.execute({ code: `if (true) { 2 }` }))

    expect(result).toStrictEqual({ ok: true, value: null, declarations: {}, toolCalls: [] })
  })

  test("returns null when the final top-level statement is not an expression", async () => {
    const result = await Effect.runPromise(CodeMode.execute({ code: `1; const value = 2` }))

    expect(result).toStrictEqual({ ok: true, value: null, declarations: { value: 2 }, toolCalls: [] })
  })

  test("rejects invalid configuration and search limits", async () => {
    expect(() => CodeMode.execute({ code: "return 1", limits: { timeoutMs: 0 } })).toThrow(RangeError)
    expect(() => CodeMode.execute({ code: "return 1", limits: { timeoutMs: Number.POSITIVE_INFINITY } })).toThrow(
      RangeError,
    )
    expect(() => CodeMode.execute({ code: "return 1", limits: { maxToolCalls: -1 } })).toThrow(RangeError)
    expect(() => CodeMode.execute({ code: "return 1", limits: { maxOutputBytes: -1 } })).toThrow(RangeError)

    const result = await Effect.runPromise(
      CodeMode.make({ tools }).execute(`return tools.search({ query: "order", limit: 0.5 })`),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.kind).toBe("InvalidToolInput")

    for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
      const invalidOffset = await Effect.runPromise(
        CodeMode.make({ tools }).execute(`return tools.search({ query: "order", offset: ${JSON.stringify(offset)} })`),
      )
      expect(invalidOffset.ok).toBe(false)
      if (!invalidOffset.ok) expect(invalidOffset.error.kind).toBe("InvalidToolInput")
    }
  })

  test("enforces the tool-call limit as a diagnostic", async () => {
    const result = await Effect.runPromise(CodeMode.execute({ tools, code: source, limits: { maxToolCalls: 0 } }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe("ToolCallLimitExceeded")
  })

  test("timeoutMs and maxToolCalls have no defaults: absent means unlimited", async () => {
    // 150 tool calls would have exceeded the old default cap of 100; with no limits
    // provided, there is no cap and no timeout - budgets are host policy.
    const counter = Tool.make({
      description: "Count invocations",
      input: Schema.Struct({}),
      output: Schema.Number,
      execute: () => Effect.succeed(1),
    })
    const result = await Effect.runPromise(
      CodeMode.execute({
        tools: { host: { count: counter } },
        code: `
        let total = 0
        for (let i = 0; i < 150; i += 1) total += tools.host.count({})
        return total
      `,
      }),
    )
    expect(result).toMatchObject({ ok: true, value: 150 })
    if (result.ok) expect(result.toolCalls.length).toBe(150)
  })

  test("the timeout interrupts a busy loop without any operation budget", async () => {
    // Regression: timeout interruption must not depend on interpreter-side work accounting.
    // The Effect fiber runtime auto-yields between interpreter steps, so a pure `while
    // (true) {}` loop is interrupted by `timeoutMs` alone.
    const startedAt = Date.now()
    const result = await Effect.runPromise(CodeMode.execute({ code: "while (true) {}", limits: { timeoutMs: 200 } }))
    const elapsedMs = Date.now() - startedAt

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe("TimeoutExceeded")
      expect(result.error.message).toContain("timed out after 200ms")
    }
    expect(elapsedMs).toBeLessThan(3_000)
  })
})
