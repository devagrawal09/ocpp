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

const rejection = (code: string) => {
  const error = (() => {
    try {
      compile(code)
      return undefined
    } catch (thrown) {
      return thrown
    }
  })()
  if (!(error instanceof CompileError)) throw new Error("Expected a CompileError")
  return error
}

const suggestions = (code: string) => rejection(code).suggestions

describe("compile suggestions", () => {
  test("a regular expression with a literal pattern gets the exact string-method rewrite", () => {
    expect(suggestions(`const ids = lines.filter((line) => /^id-/.test(line))`)).toEqual([
      'Replace /^id-/.test(line) with line.startsWith("id-")',
    ])
    expect(suggestions(`const failed = /error/i.test(log.text)`)).toEqual([
      'Replace /error/i.test(log.text) with log.text.toLowerCase().includes("error")',
    ])
    expect(suggestions(`const hits = text.match(/TODO/)`)).toEqual([
      'Use text.includes("TODO") to test for the text, or text.indexOf("TODO") to find where it starts',
    ])
    expect(suggestions(`const clean = name.replace(/-/g, "_")`)).toEqual([
      'Use a string pattern: name.replaceAll("-", "_")',
    ])
    expect(suggestions(`const cells = row.split(/,/)`)).toEqual(['Use a string separator: row.split(",")'])
  })

  test("common regular-expression idioms map to their string equivalents", () => {
    expect(suggestions(`const words = text.split(/\\s+/)`)).toEqual([
      'Split on single spaces and drop empty parts: text.split(" ").filter((part) => part !== "")',
    ])
    expect(suggestions(`const lines = file.content.split(/\\r?\\n/)`)).toEqual([
      'Split lines with a string separator: file.content.split("\\n")',
    ])
    expect(suggestions(`const id = line.match(/id-(\\d+)/)`)).toEqual([
      'Find the fixed text with line.indexOf("id-"), read what follows with line.slice(line.indexOf("id-") + 3), and cut it with split or indexOf',
    ])
    const regex = rejection(`const pattern = new RegExp("a+")`)
    expect(regex.message).toStartWith("Regular expressions are not available")
    expect(regex.suggestions).toEqual([
      'Test text with text.includes("error"), text.startsWith("id-"), or text.endsWith(".ts")',
      'Extract parts with text.split(":"), text.indexOf("="), and text.slice(start, end)',
    ])
  })

  test("a saved tool handle is rebound with let", () => {
    expect(suggestions(`const inspect = tool.define({ name: "inspect" })`)).toEqual([
      "Bind it with let so it lives for this execution only: let inspect = tool.define({ name, description, inputSchema, outputSchema, execute })",
      "Or create the handle inside the function that passes it to a tool.",
    ])
  })

  test("top-level destructuring is rewritten into one durable name per value, or local let", () => {
    expect(suggestions(`const { branch, files: changed } = tools.git.status({})`)).toEqual([
      "Save one name per value: const result = tools.git.status(...); const branch = result.branch; const changed = result.files",
      "Or keep them for this execution only with let: let { branch, files: changed } = tools.git.status(...)",
    ])
    expect(suggestions(`const [first, , result] = rows`)).toEqual([
      "Save one name per value: const value = rows; const first = value[0]; const result = value[2]",
      "Or keep them for this execution only with let: let [first, , result] = rows",
    ])
  })

  test("dynamic tool dispatch points to tools.search and explicit branches", () => {
    const expected = [
      'Find the exact path with tools.search({ query: "what the tool does" }), then call that path directly in the next execution, e.g. tools.fs.read({ path }).',
      'To choose between known tools, branch explicitly: mode === "read" ? tools.fs.read(input) : tools.fs.write(input).',
    ]
    expect(suggestions(`const read = tools[name]({ path: "a" })`)).toEqual(expected)
    expect(suggestions(`const fs = tools.fs`)).toEqual(expected)
  })

  test("mutation is rewritten as a copy of the value the model named", () => {
    expect(suggestions(`let items = []\nitems.push(entry)`)).toEqual([
      "Build a new array instead: items = [...items, entry] for a let binding, or const next = [...items, entry]",
    ])
    expect(suggestions(`let rows = []\nrows.sort((a, b) => a.size - b.size)`)).toEqual([
      "Use rows.toSorted(...) with the same comparator; it returns a new sorted array",
    ])
    expect(suggestions(`let totals = {}\ntotals.count += 2`)).toEqual([
      "Create an updated copy: { ...totals, count: totals.count + 2 }, kept in a let binding or a new const",
    ])
    expect(suggestions(`let seen = {}\ndelete seen.draft`)).toEqual([
      'Omit the key in a copy: Object.fromEntries(Object.entries(seen).filter(([key]) => key !== "draft"))',
    ])
  })

  test("removed values and unsupported forms name their supported replacement", () => {
    expect(suggestions(`const now = new Date()`)?.[0]).toStartWith("Use epoch milliseconds with the time helpers: time.now()")
    expect(suggestions(`const seen = new Set(ids)`)?.[0]).toContain("items.includes(item)")
    expect(suggestions(`async function load(path) { return tools.fs.read({ path }) }`)).toEqual([
      "Remove async and await: tool calls block and return their value, e.g. function load(path) { return tools.fs.read({ path }) }",
    ])
    expect(suggestions(`var total = 0`)).toEqual([
      "Use let for working state or const to save a notebook value: let total = ...",
    ])
  })

  test("classes and this are rejected before execution with a plain-function rewrite", () => {
    const declared = rejection(`class Counter {}`)
    expect(declared.kind).toBe("UnsupportedSyntax")
    expect(declared.suggestions).toEqual([
      "Use a function that returns a plain record: function counter(start) { return { value: start } }",
    ])
    // The body never runs, so only the compiler can reject it.
    expect(rejection(`function area() { return this.width }`).message).toBe("this is not supported")
  })

  test("an import TypeScript elided is reported as an import, not an export", () => {
    const error = rejection(`import type { Issue } from "linear"\nconst count = 1`)
    expect(error.message).toBe("imports and exports are not supported")
    expect(error.suggestions?.[0]).toStartWith("Remove it: there are no modules.")
  })

  test("the rewrites a suggestion shows run in the supported language", async () => {
    const after = (suggestion: string | undefined, marker: string) =>
      suggestion?.slice(suggestion.indexOf(marker) + marker.length) ?? ""
    const destructured = suggestions(`const { branch, files: changed } = status`)
    const programs = [
      'const line = "id-7"\nreturn ' + after(suggestions(`const ok = /^id-/.test(line)`)?.[0], " with "),
      'const text = "a  b c"\nreturn ' + after(suggestions(`const words = text.split(/\\s+/)`)?.[0], ": "),
      'const name = "a-b-c"\nreturn ' + after(suggestions(`const clean = name.replace(/-/g, "_")`)?.[0], ": "),
      'const status = { branch: "main", files: ["a"] }\n' + after(destructured?.[0], ": ") + "\nreturn [branch, changed]",
      'const status = { branch: "main", files: ["a"] }\n' + after(destructured?.[1], ": ") + "\nreturn [branch, changed]",
      'const seen = { draft: 1, kept: 2 }\nreturn ' + after(suggestions(`let seen = {}\ndelete seen.draft`)?.[0], ": "),
    ]
    const results = await Promise.all(programs.map((code) => run(code)))
    expect(results.map((result) => (result.ok ? result.value : result.error.message))).toEqual([
      true,
      ["a", "b", "c"],
      "a_b_c",
      ["main", ["a"]],
      ["main", ["a"]],
      { kept: 2 },
    ])
  })
})
