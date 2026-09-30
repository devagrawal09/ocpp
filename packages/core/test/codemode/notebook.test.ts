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
  test("omits the inventory when no values have been saved", () => {
    expect(CodeModeNotebook.inventory({})).toBe("")
  })
  test("inspects actual saved functions, own source, captures, dependencies and data", async () => {
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
    expect(listed).toMatchObject({ ok: true })
    if (!listed.ok) return
    expect(JSON.stringify(listed.value)).toContain("objectArrow")
    expect(JSON.stringify(listed.value)).toContain("(x) =")
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
    const runtime = CodeMode.make({
      bindings,
      tools: CodeModeNotebook.tools(bindings),
      limits: { maxOutputBytes: limits.maxPreviewBytes },
    })
    const listed = await Effect.runPromise(runtime.execute('return tools.notebook.list({ offset: 8, query: "saved" })'))
    expect(listed).toMatchObject({ ok: true, value: { total: 512, next: 16 } })
    if (!listed.ok) return
    expect(new TextEncoder().encode(JSON.stringify(listed.value)).length).toBeLessThanOrEqual(limits.maxPreviewBytes)
    expect(JSON.stringify(listed.value)).toContain("saved8")
    const inspected = await Effect.runPromise(runtime.execute("return tools.notebook.inspect({ value: saved0 })"))
    expect(inspected).toMatchObject({ ok: true, value: { name: "saved0", kind: "record" } })
    if (!inspected.ok) return
    expect(new TextEncoder().encode(JSON.stringify(inspected.value)).length).toBeLessThanOrEqual(limits.maxPreviewBytes)
  })
})
