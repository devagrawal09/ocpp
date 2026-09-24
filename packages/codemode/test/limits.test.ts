import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { CodeMode, Tool } from "../src/index.js"

// The host is asked for a value no program could have built, so the boundary is what must refuse it.
const oversized = Tool.make({
  description: "Return a value past the materialized value limit",
  input: Schema.Struct({ kind: Schema.String }),
  output: Schema.Unknown,
  execute: (input) => Effect.succeed(input.kind === "items" ? new Array(1_000_001).fill(0) : "x".repeat(5_000_000)),
})

const run = (code: string) => Effect.runPromise(CodeMode.execute({ code, tools: { oversized } }))

const failure = async (code: string) => {
  const result = await run(code)
  if (result.ok) throw new Error(`expected failure, got value ${JSON.stringify(result.value)}`)
  return result.error
}

const value = async (code: string) => {
  const result = await run(code)
  if (!result.ok) throw new Error(`expected success, got ${result.error.kind}: ${result.error.message}`)
  return result.value
}

// Every case here is O(1) source that asks for an enormous value. They pass by returning a
// diagnostic immediately: without the limits the host would allocate for seconds or die first.
describe("materialized value limits", () => {
  test("refuses array lengths before the host allocates them", async () => {
    for (const code of [
      "return Array.from({ length: 4000000000 }).length",
      "return Array(4000000000).length",
      "return new Array(4000000000).length",
      "return Array.from({ length: 4000000000 }, (_, index) => index).length",
    ]) {
      expect(await failure(code)).toMatchObject({
        kind: "InvalidDataValue",
        message: expect.stringContaining("1000000-item limit"),
      })
    }
  })

  test("refuses string amplification before the native call runs", async () => {
    for (const code of [
      'return "ab".repeat(3000000000).length',
      'return "x".padStart(4000000000).length',
      'return "x".padEnd(4000000000, "ab").length',
      'return "a".repeat(1000).replaceAll("a", "b".repeat(1000000)).length',
      'return "x".repeat(3000000).concat("x".repeat(3000000)).length',
      "return `${'x'.repeat(3000000)}${'x'.repeat(3000000)}`.length",
      'const item = "x".repeat(3000000); return [item, item].join("")',
      'const item = "x"; return [item, item].join("y".repeat(5000000))',
    ]) {
      expect(await failure(code)).toMatchObject({
        kind: "InvalidDataValue",
        message: expect.stringContaining("4000000-character limit"),
      })
    }
  })

  test("refuses collections that composition grows past the limit", async () => {
    for (const code of [
      "const items = Array(1000000); return items.concat(items).length",
      "const items = Array(1000000); return items.toSpliced(0, 0, 1).length",
      "const items = Array(600000); return [...items, ...items].length",
      "const items = Array(600000); return Math.max(...items, ...items)",
      'return "x".repeat(1100000).split("").length',
      "const row = Array.from({ length: 1001 }, () => 1); return Array.from({ length: 1001 }, () => row).flat().length",
      "const row = Array.from({ length: 2000 }, () => 1); return Array.from({ length: 600 }, () => row).flatMap((item) => item).length",
    ]) {
      expect(await failure(code)).toMatchObject({
        kind: "InvalidDataValue",
        message: expect.stringContaining("1000000-item limit"),
      })
    }
  })

  test("stops a doubling chain instead of letting it reach the host's own ceiling", async () => {
    expect(
      await failure('let text = "x"; for (let index = 0; index < 40; index++) { text += text } return text.length'),
    ).toMatchObject({
      kind: "InvalidDataValue",
      message: expect.stringContaining("4000000-character limit"),
    })
  })

  test("reports the limit as a catchable RangeError", async () => {
    expect(await value("try { Array(4000000000) } catch (error) { return error.name }")).toBe("RangeError")
  })

  test("refuses a tool result larger than one value may hold", async () => {
    expect(await failure('return tools.oversized({ kind: "items" }).length')).toMatchObject({
      kind: "InvalidToolOutput",
      message: expect.stringContaining("1000000-item limit"),
    })
    expect(await failure('return tools.oversized({ kind: "characters" }).length')).toMatchObject({
      kind: "InvalidToolOutput",
      message: expect.stringContaining("4000000-character limit"),
    })
  })

  test("leaves ordinary composition alone", async () => {
    expect(await value('return "ab".repeat(3).padStart(8, "-")')).toBe("--ababab")
    expect(await value('return "a,b,c".split(",").concat(["d"]).join("|")')).toBe("a|b|c|d")
    expect(await value("return [[1, 2], [3]].flat().flatMap((item) => [item, item]).length")).toBe(6)
    expect(await value("return Array.from({ length: 1000 }, (_, index) => index).length")).toBe(1000)
    expect(await value('return "x".repeat(1000000).length')).toBe(1_000_000)
    expect(await value("return Array(1000000).length")).toBe(1_000_000)
  })
})
