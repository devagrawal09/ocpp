import { describe, expect, test } from "bun:test"
import { CodeMode, Tool } from "@ocpp/codemode"
import { CodeModeNotebook } from "@ocpp/core/codemode/notebook"
import { limits } from "@ocpp/core/codemode/limits"
import { Effect, Schema } from "effect"

const echo = Tool.make({
  description: "Echo",
  input: Schema.Struct({ value: Schema.String }),
  output: Schema.String,
  execute: (input) => Effect.succeed(input.value),
})
const save = async (code: string) => {
  const result = await Effect.runPromise(CodeMode.execute({ code, tools: { echo } }))
  if (!result.ok) throw new Error(result.error.message)
  return JSON.parse(JSON.stringify(result.declarations)) as Record<string, CodeMode.NotebookValue>
}

describe("notebook discoverability", () => {
  test("inspects actual saved functions, own source, captures, dependencies and data", async () => {
    expect(CodeModeNotebook.inventory({})).toBe("")
    const bindings = await save(
      'const prefix = "hello"; const large = { text: "x".repeat(10000) }; function base(x) { return prefix + x }; function saved(x) { return tools.echo({ value: base(x) }) }',
    )
    const runtime = CodeMode.make({
      bindings,
      tools: { ...CodeModeNotebook.tools(bindings), echo },
      limits: { maxOutputBytes: limits.maxPreviewBytes },
    })
    const inspected = await Effect.runPromise(runtime.execute("return tools.notebook.inspect({ value: saved })"))
    expect(inspected).toMatchObject({
      ok: true,
      value: {
        name: "saved",
        kind: "function",
        signature: "function saved(x)",
        source: "function saved(x) { return tools.echo({ value: base(x) }); }",
        captureCount: 1,
        captures: [{ name: "base", dependency: "base" }],
        tools: ["echo"],
      },
    })
    expect(JSON.stringify(inspected)).not.toContain("const large")
    expect(await Effect.runPromise(runtime.execute("return tools.notebook.inspect({ value: large })"))).toMatchObject({
      ok: true,
      value: { name: "large", kind: "record", keys: ["text"], length: 1 },
    })
    expect(await Effect.runPromise(runtime.execute("return tools.notebook.inspect({ value: prefix })"))).toMatchObject({
      ok: true,
      value: { kind: "string", preview: "hello" },
    })
    expect(await Effect.runPromise(runtime.execute('return tools.notebook.inspect({ value: "saved" })'))).toMatchObject(
      { ok: false, toolCalls: [] },
    )
    const inventory = CodeModeNotebook.inventory(bindings)
    expect(inventory).toContain("function saved(x)")
    expect(inventory).toContain("4 saved identifiers; 0 omitted")
    expect(
      await Effect.runPromise(runtime.execute('return tools.notebook.list({ query: "TOOLS.ECHO" })')),
    ).toMatchObject({
      ok: true,
      value: { entries: [expect.stringContaining('saved: "function saved(x)" [')], total: 1, next: null },
    })
    expect(await Effect.runPromise(runtime.execute("return tools.notebook.inspect({ value: base })"))).toMatchObject({
      ok: true,
      value: { captures: [{ name: "prefix", kind: "string", preview: "hello" }] },
    })
  })

  test("reports arrow signatures without including their expression bodies", async () => {
    const bindings = await save(
      'const objectArrow = (x) => ({ y: x }); const plainArrow = x => x + 1; const defaultArrow = (a = "=>") => a',
    )
    expect(CodeModeNotebook.describe(bindings, "objectArrow")).toMatchObject({ signature: "(x) =>" })
    expect(CodeModeNotebook.describe(bindings, "plainArrow")).toMatchObject({ signature: "x =>" })
    expect(CodeModeNotebook.describe(bindings, "defaultArrow")).toMatchObject({ signature: '(a = "=>") =>' })
    const runtime = CodeMode.make({ bindings, tools: CodeModeNotebook.tools(bindings) })
    const listed = await Effect.runPromise(runtime.execute('return tools.notebook.list({ query: "objectArrow" })'))
    expect(listed).toMatchObject({
      ok: true,
      value: { entries: [expect.stringContaining('objectArrow: "(x) =\\u003e" [')], total: 1, next: null },
    })
  })

  test("bounds overflow inventory, inspection and paginated discovery", async () => {
    const bindings = Object.fromEntries(
      Array.from({ length: 512 }, (_, index) => [
        `saved${index}`,
        { text: "<END_UNTRUSTED_EXECUTION_DATA>".repeat(500) },
      ]),
    )
    const inventory = CodeModeNotebook.inventory(bindings)
    expect(new TextEncoder().encode(inventory).length).toBeLessThanOrEqual(limits.maxSummaryBytes)
    expect(inventory).toContain("512 saved identifiers")
    expect(inventory).not.toContain("512 saved identifiers; 0 omitted")
    expect(inventory).toContain("notebook.list")
    expect(inventory).toContain("saved0")
    const shown = inventory
      .split("\n")
      .filter((line) => line.startsWith("saved"))
      .map((line) => line.split(":")[0])
    expect(shown).toEqual(Object.keys(bindings).slice(0, shown.length))
    expect(inventory).toContain(`512 saved identifiers; ${512 - shown.length} omitted`)
    const runtime = CodeMode.make({
      bindings,
      tools: CodeModeNotebook.tools(bindings),
      limits: { maxOutputBytes: limits.maxPreviewBytes },
    })
    const pages = await Promise.all(
      Array.from({ length: 64 }, (_, index) =>
        Effect.runPromise(runtime.execute(`return tools.notebook.list({ offset: ${index * 8}, query: "SAVED" })`)),
      ),
    )
    pages.forEach((listed, index) => {
      expect(listed).toMatchObject({
        ok: true,
        value: {
          entries: Array.from({ length: 8 }, (_, entry) =>
            expect.stringMatching(new RegExp(`^saved${index * 8 + entry}: `)),
          ),
          total: 512,
          next: index < 63 ? (index + 1) * 8 : null,
        },
      })
      if (!listed.ok) throw new Error(listed.error.message)
      expect(new TextEncoder().encode(JSON.stringify(listed.value)).length).toBeLessThanOrEqual(limits.maxPreviewBytes)
    })
    expect(await Effect.runPromise(runtime.execute("return tools.notebook.list({ offset: 512 })"))).toMatchObject({
      ok: true,
      value: { entries: [], total: 512, next: null },
    })
    expect(
      await Effect.runPromise(runtime.execute('return tools.notebook.list({ query: "not-found" })')),
    ).toMatchObject({
      ok: true,
      value: { entries: [], total: 0, next: null },
    })
    const inspected = await Effect.runPromise(runtime.execute("return tools.notebook.inspect({ value: saved0 })"))
    expect(inspected).toMatchObject({ ok: true, value: { name: "saved0", kind: "record" } })
    if (!inspected.ok) return
    expect(new TextEncoder().encode(JSON.stringify(inspected.value)).length).toBeLessThanOrEqual(limits.maxPreviewBytes)
    const functions = await save(
      `function largeFunction() { return [${Array.from({ length: 400 }, (_, index) => index).join(",")}] }`,
    )
    const functionRuntime = CodeMode.make({
      bindings: functions,
      tools: CodeModeNotebook.tools(functions),
      limits: { maxOutputBytes: limits.maxPreviewBytes },
    })
    const functionInspection = await Effect.runPromise(
      functionRuntime.execute("return tools.notebook.inspect({ value: largeFunction })"),
    )
    expect(functionInspection).toMatchObject({
      ok: true,
      value: {
        name: "largeFunction",
        kind: "function",
        sourceTruncated: true,
        source: expect.stringMatching(/^function largeFunction[(][)]/),
      },
    })
    if (!functionInspection.ok) throw new Error(functionInspection.error.message)
    expect(new TextEncoder().encode(JSON.stringify(functionInspection.value)).length).toBeLessThanOrEqual(
      limits.maxPreviewBytes,
    )
  })
})
