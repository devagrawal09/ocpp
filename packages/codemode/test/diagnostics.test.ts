import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { CodeMode, compile, CompileError } from "../src/index.js"

const run = (code: string) => Effect.runPromise(CodeMode.execute({ code }))

describe("compile diagnostics", () => {
  test("a TypeScript parse failure carries its kind, one-based location, and source excerpt", async () => {
    const result = await run(["const a = 1", "const b = {,}", "return b"].join("\n"))
    expect(result).toMatchObject({
      ok: false,
      error: {
        kind: "ParseError",
        message: "Failed to parse TypeScript: Property assignment expected. (line 2, col 12)",
        location: { line: 2, column: 12 },
        excerpt: "const b = {,}",
      },
    })
  })

  test("a JavaScript parse failure from the parser is positioned the same way", () => {
    const error = (() => {
      try {
        // TypeScript transpilation reports only syntax; acorn is the parser that rejects this.
        compile(["const a = 1", "const a = 2", "return a"].join("\n"))
        return undefined
      } catch (thrown) {
        return thrown
      }
    })()
    expect(error).toBeInstanceOf(CompileError)
    if (!(error instanceof CompileError)) return
    expect(error.kind).toBe("ParseError")
    expect(error.message).toBe("Failed to parse: Identifier 'a' has already been declared")
    expect(error.location).toEqual({ line: 2, column: 7 })
    expect(error.excerpt).toBe("const a = 2")
  })

  test("unsupported syntax reports the exact node position", async () => {
    const result = await run(["const a = 1", "let b = /x/", "return b"].join("\n"))
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "UnsupportedSyntax", location: { line: 2, column: 9 } },
    })
    if (result.ok) return
    expect(result.error.message).toEndWith("(line 2, col 9)")
    expect(result.error.excerpt).toBeUndefined()
  })

  test("a long failing line is bounded in the excerpt", () => {
    const filler = "x".repeat(400)
    const error = (() => {
      try {
        compile(`const a = {,} // ${filler}`)
        return undefined
      } catch (thrown) {
        return thrown
      }
    })()
    if (!(error instanceof CompileError)) throw new Error("Expected a CompileError")
    expect(error.excerpt?.length).toBe(203)
    expect(error.excerpt?.endsWith("...")).toBe(true)
  })
})
