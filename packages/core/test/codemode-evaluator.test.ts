import { expect } from "bun:test"
import { Agent } from "@ocpp/schema/agent"
import { Session } from "@ocpp/schema/session"
import { SessionMessage } from "@ocpp/schema/session-message"
import { Tool } from "@ocpp/schema/tool"
import { Effect, Layer, Schema } from "effect"
import { CodeModeEvaluator } from "../src/codemode/evaluator"
import { execute } from "../src/tool/runtime"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const add = {
  name: "add",
  description: "Add two numbers",
  input: Schema.Struct({ a: Schema.Number, b: Schema.Number }),
  output: Schema.Struct({ sum: Schema.Number }),
  execute: ({ a, b }) => Effect.succeed({ output: { sum: a + b } }),
} satisfies Tool.Info

const bad = {
  name: "bad",
  description: "Declares a number but returns text",
  input: Schema.Struct({}),
  output: Schema.Struct({ n: Schema.Number }),
  execute: () => Effect.succeed({ output: { n: "nope" } as unknown as { n: number } }),
} satisfies Tool.Info

const setup = () => {
  const counter = { count: 0 }
  const secret = {
    name: "secret",
    description: "Not exposed to nested programs",
    input: Schema.Struct({}),
    output: Schema.Struct({ ok: Schema.Boolean }),
    execute: () => Effect.succeed({ output: { ok: true } }),
  } satisfies Tool.Info
  const count = {
    name: "count",
    description: "Counts invocations",
    input: Schema.Struct({}),
    output: Schema.Struct({ calls: Schema.Number }),
    execute: () => Effect.sync(() => ({ output: { calls: ++counter.count } })),
  } satisfies Tool.Info
  const inspect = {
    name: "inspect",
    description: "Reports the catalog and call id it was given",
    input: Schema.Struct({}),
    output: Schema.Struct({ catalog: Schema.Array(Schema.String), id: Schema.String }),
    options: { acceptsToolHandles: true },
    execute: (_input, context) =>
      Effect.succeed({ output: { catalog: [...(context.catalog?.keys() ?? [])].sort(), id: context.id } }),
  } satisfies Tool.Info
  const all = [add, bad, secret, count, inspect] as ReadonlyArray<Tool.Info>
  const catalog = new Map(all.map((tool) => [tool.name, { tool, lent: false }] as const))
  const context: Tool.Context = {
    sessionID: Session.ID.make("ses_evaluator"),
    agent: Agent.ID.make("build"),
    messageID: SessionMessage.ID.make("msg_evaluator"),
    id: Tool.CallID.make("call_evaluator"),
    progress: () => Effect.void,
    catalog,
  }
  const evaluator = CodeModeEvaluator.tool((_name, tool, input, ctx) => execute(tool, input, ctx))
  const run = (input: Parameters<typeof evaluator.execute>[0]) => evaluator.execute(input, context)
  return { counter, run }
}

const keys = (value: unknown) => Object.keys(value as object).sort()

it.effect("can describe a capability with no admitted tool calls", () =>
  Effect.gen(function* () {
    const fixture = setup()
    const result = yield* fixture.run({ code: "return tools.count({})", tools: ["count"], maxToolCalls: 0 })
    expect(result.output).toMatchObject({ ok: false, error: { kind: "ToolCallLimitExceeded" } })
    expect(fixture.counter.count).toBe(0)
  }),
)

it.effect("takes plain data in and returns plain data without notebook declarations", () =>
  Effect.gen(function* () {
    const { run } = setup()
    const result = yield* run({
      code: "const doubled = input.n * 2\nreturn { doubled, list: [1, 2] }",
      input: { n: 21 },
    })
    expect(result.output).toMatchObject({ ok: true, value: { doubled: 42, list: [1, 2] } })
    expect(keys(result.output)).toEqual(["ok", "toolCalls", "value"])
    expect(JSON.stringify(result.output)).not.toContain('doubled":42,"declarations')
    // The declaration was local to the nested program: a later evaluation cannot see it.
    const later = yield* run({ code: "return typeof doubled" })
    expect(later.output).toMatchObject({ ok: true, value: "undefined" })
  }),
)

it.effect("describes a temporary capability whose execute closure calls a host tool", () =>
  Effect.gen(function* () {
    const fixture = setup()
    const result = yield* fixture.run({
      code: "function createCapability() { return { id: 'add', execute: () => tools.add({ a: 1, b: 2 }) } }; const capability = createCapability(); return { id: capability.id };",
      tools: ["add"],
      maxToolCalls: 0,
    })
    expect(result.output).toMatchObject({ ok: true, value: { id: "add" }, toolCalls: [] })
  }),
)

it.effect("runs generated function source in a later, separate evaluation", () =>
  Effect.gen(function* () {
    const { run } = setup()
    const generated = yield* run({ code: 'return "(x) => tools.add({ a: x, b: 1 }).sum"', tools: [] })
    const source = (generated.output as { value: string }).value
    const result = yield* run({ code: "const f = " + source + "\nreturn f(input)", input: 41, tools: ["add"] })
    expect(result.output).toMatchObject({ ok: true, value: 42 })
  }),
)

it.effect("does not persist temporary capability objects with live tool captures", () =>
  Effect.gen(function* () {
    const fixture = setup()
    const source =
      "function createCapability() { return { id: 'add', execute: (x) => tools.add({ a: x, b: 1 }) } }\nconst capability = createCapability();"
    const described = yield* fixture.run({
      code: source + "return { id: capability.id }",
      tools: ["add"],
      maxToolCalls: 0,
    })
    expect(described.output).toMatchObject({ ok: true, value: { id: "add" } })
    const executed = yield* fixture.run({
      code: source + "return capability.execute(input)",
      input: 41,
      tools: ["add"],
    })
    expect(executed.output).toMatchObject({ ok: true, value: { sum: 42 } })
  }),
)

it.effect("refuses unexposed static tool references before any side effect", () =>
  Effect.gen(function* () {
    const { counter, run } = setup()
    const error = yield* run({ code: "tools.count({})\ntools.secret({})\nreturn 1", tools: ["count"] }).pipe(
      Effect.flip,
    )
    expect(error).toBeInstanceOf(Tool.Error)
    expect(error.message).toContain("tools.secret")
    expect(counter.count).toBe(0)
    const hidden = yield* run({ code: "return 1", tools: ["nothing"] }).pipe(Effect.flip)
    expect(hidden.message).toContain("tools.nothing is not available")
  }),
)

it.effect("validates tool input and output through the runtime gateway", () =>
  Effect.gen(function* () {
    const { run } = setup()
    const input = yield* run({ code: 'return tools.add({ a: "x", b: 1 })', tools: ["add"] })
    expect(input.output).toMatchObject({ ok: false })
    expect(JSON.stringify(input.output)).toContain("add")
    const output = yield* run({ code: "return tools.bad({})", tools: ["bad"] })
    expect(output.output).toMatchObject({ ok: false })
    const valid = yield* run({ code: "return tools.add({ a: 2, b: 3 })", tools: ["add"] })
    expect(valid.output).toMatchObject({ ok: true, value: { sum: 5 } })
  }),
)

it.effect("returns a runtime diagnostic for unavailable ambient eval and fetch", () =>
  Effect.gen(function* () {
    const { run } = setup()
    for (const code of ['return eval("1 + 1")', 'return fetch("https://example.com")']) {
      const result = yield* run({ code, tools: [] })
      expect(result.output).toMatchObject({ ok: false })
      expect(JSON.stringify(result.output)).toMatch(/eval|fetch/)
    }
  }),
)

it.effect("gives nested tools only the selected catalog subset and child call ids", () =>
  Effect.gen(function* () {
    const { run } = setup()
    const result = yield* run({
      code: "return [tools.inspect({}), tools.inspect({})]",
      tools: ["inspect", "add"],
    })
    const value = Schema.decodeUnknownSync(
      Schema.Struct({
        value: Schema.Array(Schema.Struct({ catalog: Schema.Array(Schema.String), id: Schema.String })),
      }),
    )(result.output).value
    expect(value[0].catalog).toEqual(["add", "inspect"])
    expect(value[0].id).toMatch(/^call_evaluator:\d+$/)
    expect(value[1].id).toMatch(/^call_evaluator:\d+$/)
    expect(value[0].id).not.toBe(value[1].id)
  }),
)
