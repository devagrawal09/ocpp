import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CodeMode, isToolHandle, Tool } from "../src/index.js"

const echo = Tool.make({
  description: "Echo a value",
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.Struct({ value: Schema.String }),
  execute: (input) => Effect.succeed(input),
})

const run = (code: string, bindings?: Readonly<Record<string, Schema.Json>>) =>
  Effect.runPromise(CodeMode.execute({ code, bindings, tools: { echo } }))

describe("compiled activation runtime", () => {
  test("calls tools directly and publishes all exports", async () => {
    const result = await run(`const response = tools.echo({ value: "ok" })
export const answer = { value: response.value }
return answer`)

    expect(result).toMatchObject({
      ok: true,
      value: { value: "ok" },
      exports: { answer: { value: "ok" } },
      toolCalls: [{ name: "echo" }],
    })
  })

  test("passes same-cell tool handles with immutable captures", async () => {
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
const readerMap = new Map([["suffix", () => suffix]])
const readerSet = new Set([() => suffix])
const decorate = tool.define({
  name: "decorate",
  description: "Decorate text",
  inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  outputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
  execute: (input) => tools.echo({
    value: input.value + state[Symbol.iterator]() + readers[0]() + readerMap.get("suffix")() + [...readerSet][0](),
  }),
})
suffix = "?"
return tools.delegate({ handle: decorate, input: { value: "ok" } })`,
      }),
    )

    expect(result).toMatchObject({
      ok: true,
      value: { value: "ok!!!!" },
      toolCalls: [{ name: "delegate" }, { name: "echo" }],
    })
  })

  test("loads immutable committed bindings", async () => {
    const result = await run("export const next = previous.map((value) => value * 2)", { previous: [1, 2] })
    expect(result).toMatchObject({ ok: true, exports: { next: [2, 4] } })
  })

  test.each([
    ["await", "return await tools.echo({ value: 'x' })"],
    ["Promise", "return Promise.all([])"],
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

  test("allows activation-local let", async () => {
    const result = await run("let total = 1; total += 2; return total")
    expect(result).toMatchObject({ ok: true, value: 3 })
  })

  test("shares activation-local let with synchronous callbacks", async () => {
    const result = await run("let total = 0; [1, 2, 3].forEach((value) => { total += value }); return total")
    expect(result).toMatchObject({ ok: true, value: 6 })
  })

  test.each([
    "const value = []; const method = 'push'; value[method](1); return value",
    "const value = new Map(); const method = 'set'; value[method]('key', 1); return value",
    "const value = new Set(); const method = 'add'; value[method](1); return value",
    "const value = new Date(0); const method = 'setTime'; value[method](1); return value",
    "const value = {}; const method = 'assign'; Object[method](value, { changed: true }); return value",
    "const value = new URLSearchParams(); const method = 'append'; value[method]('key', 'value'); return value",
  ])("rejects computed aggregate mutation: %s", async (code) => {
    const result = await run(code)
    expect(result).toMatchObject({ ok: false, error: { kind: "UnsupportedSyntax" } })
  })

  test("enforces delegated tool capabilities through captured helpers", async () => {
    const delegate = Tool.make({
      description: "Invoke a delegated handle",
      input: Schema.Struct({ handle: Schema.Unknown }),
      output: Schema.Unknown,
      acceptsToolHandles: true,
      execute: ({ handle }) =>
        isToolHandle(handle) ? handle.invoke({ value: "ok" }) : Effect.fail(new Error("Expected a tool handle")),
    })
    const result = await Effect.runPromise(
      CodeMode.execute({
        tools: { echo, delegate },
        code: `const helper = (input) => tools.echo(input)
const hidden = tool.define({
  name: "hidden",
  description: "Hidden capability",
  inputSchema: { type: "object" },
  outputSchema: { type: "object" },
  execute: (input) => helper(input),
})
return tools.delegate({ handle: hidden })`,
      }),
    )
    expect(result).toMatchObject({ ok: false, error: { kind: "ToolFailure" } })
    if (!result.ok) expect(result.error.message).toContain("does not declare capability 'echo'")
  })

  test("rejects handles at ordinary tool boundaries", async () => {
    const ordinary = Tool.make({
      description: "Does not accept handles",
      input: Schema.Unknown,
      output: Schema.Unknown,
      execute: Effect.succeed,
    })
    const result = await Effect.runPromise(
      CodeMode.execute({
        tools: { ordinary },
        code: `const handle = tool.define({
  name: "hidden",
  description: "Hidden",
  inputSchema: {},
  outputSchema: {},
  execute: (input) => input,
})
return tools.ordinary({ handle })`,
      }),
    )
    expect(result).toMatchObject({ ok: false, error: { kind: "InvalidDataValue" } })
  })

  test("closes handles created inside functions when the activation settles", async () => {
    let captured: unknown
    const capture = Tool.make({
      description: "Capture a delegated handle",
      input: Schema.Struct({ handle: Schema.Unknown }),
      output: Schema.Null,
      acceptsToolHandles: true,
      execute: ({ handle }) =>
        Effect.sync(() => {
          captured = handle
          return null
        }),
    })
    const result = await Effect.runPromise(
      CodeMode.execute({
        tools: { capture },
        code: `function makeHandle() {
  return tool.define({
    name: "nested",
    description: "Nested handle",
    inputSchema: {},
    outputSchema: {},
    execute: (input) => input,
  })
}
return tools.capture({ handle: makeHandle() })`,
      }),
    )
    expect(result.ok).toBe(true)
    expect(isToolHandle(captured)).toBe(true)
    if (!isToolHandle(captured)) throw new Error("Expected a tool handle")
    expect(await Effect.runPromise(Effect.flip(captured.invoke(null)))).toBeInstanceOf(Error)
  })

  test("rejects unsupported compiled IR versions", async () => {
    const program = { ...CodeMode.compile("return 1"), version: 999 } as unknown as CodeMode.Program
    const result = await Effect.runPromise(CodeMode.execute({ code: program.source, program }))
    expect(result).toMatchObject({ ok: false, error: { kind: "ExecutionFailure" }, toolCalls: [] })
  })

  test("requires direct top-level const exports", async () => {
    for (const code of ["export let value = 1", "export function value() {}", "export default 1"]) {
      const result = await run(code)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe("UnsupportedSyntax")
    }
  })
})
