import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import {
  CodeMode,
  compile,
  isToolHandle,
  isToolReference,
  staticToolCalls,
  staticToolReferences,
  Tool,
} from "../src/index.js"

const echo = Tool.make({
  description: "Echo a value",
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.Struct({ value: Schema.String }),
  execute: (input) => Effect.succeed(input),
})

// Describes what it received, as a host tool that hands tools on to someone else would.
const lend = Tool.make({
  description: "Receive tools",
  input: Schema.Struct({ tools: Schema.Array(Schema.Unknown) }),
  output: Schema.Array(Schema.String),
  acceptsToolHandles: true,
  execute: (input) =>
    Effect.succeed(
      input.tools.map((item) =>
        isToolReference(item)
          ? "reference " + item.path.join(".")
          : isToolHandle(item)
            ? "handle " + item.definition.name
            : "data",
      ),
    ),
})

const tools = { echo, lend, linear: { create: echo, list: echo } }

const run = (code: string) => Effect.runPromise(CodeMode.execute({ code, tools }))

describe("tool references", () => {
  test("a tool that accepts handles receives references to tools and namespaces", async () => {
    const result = await run(`let inspect = tool.define({
  name: "inspect",
  description: "Inspect",
  inputSchema: {},
  outputSchema: {},
  execute: (input) => tools.echo(input),
})
let list = [tools.echo, tools.linear, inspect]
return tools.lend({ tools: list })`)
    expect(result).toMatchObject({
      ok: true,
      value: ["reference echo", "reference linear", "handle inspect"],
    })
  })

  test("a reference to a path outside the catalog is refused before the call", async () => {
    const result = await run(`return tools.lend({ tools: [tools.missing] })`)
    expect(result).toMatchObject({ ok: false, error: { kind: "UnknownTool" } })
    if (!result.ok) expect(result.error.message).toContain("tools.missing")
  })

  test("a reference is not data for other tools, nor a durable value", async () => {
    const data = await run(`return tools.echo({ value: tools.echo })`)
    expect(data).toMatchObject({ ok: false, error: { kind: "InvalidDataValue" } })

    const saved = await run(`let reference = tools.echo
const kept = { reference }`)
    expect(saved).toMatchObject({ ok: false, error: { kind: "InvalidDurableValue" } })
    if (!saved.ok) expect(saved.error.message).toContain("tool reference")
  })

  test("a reference saved as a top-level const is refused at compile time with a let rewrite", () => {
    expect(() => compile(`const reader = tools.echo`)).toThrow("Tool references are activation-local")
    try {
      compile(`const reader = tools.echo`)
    } catch (error) {
      expect(error).toMatchObject({
        suggestions: ["Bind it with let so it lives for this execution only: let reader = tools.echo"],
      })
    }
  })

  test("the tools root and dynamic paths stay unavailable as values", () => {
    expect(() => compile(`let all = tools`)).toThrow("The tools root is not a value")
    expect(() => compile(`let name = "echo"; let chosen = tools[name]`)).toThrow("literal property names")
  })

  test("a reference inside a top-level const is refused at compile time, before any tool runs", async () => {
    for (const code of [
      'tools.echo({ value: "side effect" })\nconst kept = { reader: tools.echo }',
      "const kept = [tools.echo, tools.linear]",
      "const kept = input ? { reader: tools.echo } : null",
      'const kept = { inspect: tool.define({ name: "inspect", description: "d", inputSchema: {}, outputSchema: {}, execute: (input) => input }) }',
    ]) {
      const result = await run(code)
      expect(result).toMatchObject({ ok: false, error: { kind: "UnsupportedSyntax" }, toolCalls: [] })
      if (!result.ok) expect(result.error.message).toContain("'kept' would hold a tool")
    }
    // What a call returns, and a function that passes references on, are saved as usual.
    expect(await run("const given = tools.lend({ tools: [tools.echo] })")).toMatchObject({ ok: true })
    expect(await run("const lendEcho = () => tools.lend({ tools: [tools.echo] })")).toMatchObject({ ok: true })
  })

  test("a reference is called only by its static path, never through a variable, parameter or callback", async () => {
    // The compiler refuses the forms it can see: a name that only a reference binds, called or extended.
    for (const [code, message] of [
      ['let reader = tools.echo\nreturn reader({ value: "a" })', "'reader' holds the tool reference tools.echo"],
      ['let linear = tools.linear\nreturn linear.create({ value: "a" })', "cannot be extended with a member"],
      ['let linear = tools.linear\nlet name = "create"\nreturn linear[name]({ value: "a" })', "cannot be extended"],
      ['return tools.linear?.create({ value: "a" })', "Tool paths cannot use optional chaining"],
    ] as const) {
      expect(() => compile(code)).toThrow(message)
    }
    // The runtime refuses the rest before the tool runs.
    for (const [code, message] of [
      [
        'function call(reader) { return reader({ value: "a" }) }\nreturn call(tools.echo)',
        "tools.echo is a tool reference here",
      ],
      ['return [tools.echo].map((reader) => reader({ value: "a" }))', "tools.echo is a tool reference here"],
      [
        'let reader = tools.echo\nlet again = reader\nreturn again({ value: "a" })',
        "tools.echo is a tool reference here",
      ],
      [
        'function create(namespace) { return namespace.create({ value: "a" }) }\nreturn create(tools.linear)',
        "A tool reference cannot be extended with a member; name the tool by its full static path, such as tools.linear.create.",
      ],
      ['let { create } = tools.linear\nreturn create({ value: "a" })', "requires a data object"],
    ] as const) {
      const result = await run(code)
      expect(result).toMatchObject({ ok: false, toolCalls: [] })
      if (!result.ok) expect(result.error.message).toContain(message)
    }
    // A reference held in a variable is still a value to pass on, and a shadowing name is an ordinary binding.
    expect(await run("let reader = tools.echo\nreturn tools.lend({ tools: [reader] })")).toMatchObject({
      ok: true,
      value: ["reference echo"],
    })
    expect(
      await run("let reader = tools.echo\nfunction twice(reader) { return reader * 2 }\nreturn twice(2)"),
    ).toMatchObject({ ok: true, value: 4 })
    expect(await run('return tools.linear.create?.({ value: "a" })')).toMatchObject({ ok: true, value: { value: "a" } })
  })

  test("static references are listed apart from static calls", () => {
    const program = compile(
      [
        "let inspect = tool.define({ name: 'inspect', execute: (input) => tools.fs.read(input) })",
        "return tools.subagent({ tools: [tools.fs.read, tools.linear, inspect] })",
      ].join("\n"),
    )
    expect(staticToolCalls(program.body).map((call) => call.path)).toEqual(["fs.read", "subagent"])
    expect(staticToolReferences(program.body).map((reference) => reference.path)).toEqual(["fs.read", "linear"])
  })
})

describe("evaluate", () => {
  test("returns references and handles, and keeps handles callable until the scope closes", async () => {
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* CodeMode.evaluate({
            tools,
            code: `let loud = tool.define({
  name: "loud",
  description: "Echo loudly",
  inputSchema: {},
  outputSchema: {},
  execute: (input) => tools.echo({ value: input.value + "!" }),
})
return { build: [tools.echo, tools.linear, loud] }`,
          })
          if (!result.ok) return yield* Effect.die(new Error(result.error.message))
          const build = (result.value as { build: ReadonlyArray<unknown> }).build
          const handle = build[2]
          if (!isToolHandle(handle)) return yield* Effect.die(new Error("expected a handle"))
          const called = yield* handle.invoke({ value: "hi" })
          return { build, called, handle }
        }),
      ),
    )
    expect(outcome.build.slice(0, 2).map((item) => (isToolReference(item) ? item.path.join(".") : item))).toEqual([
      "echo",
      "linear",
    ])
    expect(outcome.called).toEqual({ value: "hi!" })
    const closed = await Effect.runPromise(Effect.exit(outcome.handle.invoke({ value: "late" })))
    expect(closed._tag).toBe("Failure")
  })

  test("reads top-level const as an ordinary binding, since nothing is saved", async () => {
    const code = [
      "const reader = tools.echo",
      "const named = { linear: tools.linear }",
      'const loud = tool.define({ name: "loud", description: "d", inputSchema: {}, outputSchema: {}, execute: (input) => input })',
      "return { build: [reader, named.linear, loud] }",
    ].join("\n")
    expect(compile(code, { notebook: false }).declarations).toEqual([])
    expect(() => compile(code)).toThrow("Tool references are activation-local")
    const result = await Effect.runPromise(Effect.scoped(CodeMode.evaluate({ tools, code })))
    expect(result.ok).toBe(true)
  })

  test("a deadline bounds the program's own run", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(
        CodeMode.evaluate({ tools, code: "let n = 0\nwhile (true) { n = n + 1 }", limits: { timeoutMs: 50 } }),
      ),
    )
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "TimeoutExceeded", message: "Evaluation timed out after 50ms." },
    })
  })

  test("reports a failing program as a diagnostic", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(CodeMode.evaluate({ tools, code: `throw new Error("broken init")` })),
    )
    expect(result).toMatchObject({ ok: false, error: { kind: "ExecutionFailure" } })
    if (!result.ok) expect(result.error.message).toContain("broken init")
  })
})
