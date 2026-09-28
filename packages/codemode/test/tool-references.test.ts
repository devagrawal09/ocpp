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

  test("reports a failing program as a diagnostic", async () => {
    const result = await Effect.runPromise(
      Effect.scoped(CodeMode.evaluate({ tools, code: `throw new Error("broken init")` })),
    )
    expect(result).toMatchObject({ ok: false, error: { kind: "ExecutionFailure" } })
    if (!result.ok) expect(result.error.message).toContain("broken init")
  })
})
