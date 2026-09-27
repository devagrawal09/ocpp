import { expect, test } from "bun:test"
import { CodeModeTool } from "@ocpp/core/codemode/tool"
import { Tool } from "@ocpp/core/tool"
import { Agent } from "@ocpp/schema/agent"
import { Session } from "@ocpp/schema/session"
import { SessionMessage } from "@ocpp/schema/session-message"
import type { Info } from "@ocpp/schema/tool"
import { Effect, Schema, Scope } from "effect"

const context = {
  sessionID: Session.ID.make("ses_compile_check"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_compile_check"),
  id: Tool.CallID.make("call_compile_check"),
  progress: () => Effect.void,
}

const echo = (name: string, namespace?: string): Info => ({
  name,
  description: "Echo text through " + name,
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  execute: ({ text }) => Effect.succeed({ output: { text } }),
  ...(namespace === undefined ? {} : { options: { namespace } }),
})

/** An execute tool over `tools`, recording every execution the store admits. */
const setup = (tools: ReadonlyArray<Info>, denied: ReadonlyArray<Info> = []) => {
  const admitted: string[] = []
  const codemode = CodeModeTool.create(
    new Map(tools.map((tool) => [tool.name, tool])),
    () => Effect.die("No tool runs before the outer tool result commits"),
    {
      bus: {
        publish: () => Effect.succeed(undefined as never),
        listen: () => Effect.succeed(Effect.void),
      },
      jobs: {
        startLimited: (input) =>
          Effect.succeed({ id: input.id ?? "exe", type: "codemode", status: "running", started_at: 0 }),
        active: () => Effect.succeed([]),
        wait: () => Effect.never,
        background: () => Effect.succeed(undefined),
        cancel: () => Effect.succeed(undefined),
        markBackgroundTerminal: () => Effect.void,
        completeBackground: () => Effect.void,
      },
      sessions: {
        message: () => Effect.succeed(undefined),
        synthetic: () => Effect.die("Unreached: the execution never settles here"),
      },
      store: {
        admit: (input) => {
          admitted.push(input.id)
          return Effect.succeed({ ok: true, execution: { ...input, bindings: {} } })
        },
        running: () => Effect.void,
        scheduleCall: () => Effect.void,
        settleCall: () => Effect.void,
        commit: () => Effect.die("Unreached: the execution never runs here"),
        fail: () => Effect.void,
        discard: () => Effect.void,
        indeterminate: () => Effect.void,
      },
      image: { normalize: () => Effect.die("No tool returns media in these tests") },
      scope: Effect.runSync(Scope.make()),
    },
    undefined,
    denied,
  )
  return {
    admitted,
    refuse: (code: string) => Effect.runPromise(codemode.execute({ code }, context).pipe(Effect.flip)),
    start: (code: string) => Effect.runPromise(codemode.execute({ code }, context)),
  }
}

test("an unknown tool is refused with its closest catalog path before an execution ID exists", async () => {
  const codemode = setup([echo("read", "fs"), echo("write", "fs")])
  const error = await codemode.refuse(['const path = "a.ts"', "const text = tools.fs.raed({ text: path })"].join("\n"))

  expect(error).toBeInstanceOf(Tool.Error)
  expect(error.message).toBe(
    [
      "Unknown tool tools.fs.raed; this agent has no tool at that path. (line 2, col 14)",
      "Source: const text = tools.fs.raed({ text: path })",
      "Did you mean tools.fs.read?",
      'Check its exact signature with tools.search({ query: "tools.fs.read" })',
    ].join("\n"),
  )
  expect(error.metadata).toEqual({
    executionStatus: "refused",
    kind: "UnknownTool",
    location: { line: 2, column: 14 },
    excerpt: "const text = tools.fs.raed({ text: path })",
    suggestions: [
      "Did you mean tools.fs.read?",
      'Check its exact signature with tools.search({ query: "tools.fs.read" })',
    ],
    tools: ["fs.raed"],
  })
  expect(codemode.admitted).toEqual([])
})

test("a tool the agent's permission rules deny outright is refused as denied", async () => {
  const codemode = setup([echo("echo")], [echo("shell")])
  const error = await codemode.refuse('const listing = tools.shell({ text: "ls" })')

  expect(error.message).toBe(
    [
      "Tool tools.shell is denied for this agent: its permission rules deny it outright, so no call to it can succeed. (line 1, col 17)",
      'Source: const listing = tools.shell({ text: "ls" })',
      'Do not retry it. Use an allowed tool instead (tools.search({ query: "shell" }) lists them), or ask the user to change this agent\'s permissions.',
    ].join("\n"),
  )
  expect(error.metadata).toMatchObject({ executionStatus: "refused", kind: "ToolDenied", tools: ["shell"] })
  expect(codemode.admitted).toEqual([])
})

test("a program that calls only catalog tools and tools.search is admitted", async () => {
  const codemode = setup([echo("echo")], [echo("shell")])
  const result = await codemode.start(
    ['const said = tools.echo({ text: "hi" })', 'return tools.search({ query: "echo" })'].join("\n"),
  )

  expect(result).toMatchObject({ output: { status: "running" } })
  expect(codemode.admitted).toHaveLength(1)
})

test("calls are checked wherever they appear, and every unavailable path is reported at once", async () => {
  const codemode = setup([echo("read", "fs"), echo("issues", "linear")])
  const error = await codemode.refuse(
    [
      // Neither function is called, but a static path is enough to know it can never succeed.
      "function load(path) { return tools.read({ text: path }) }",
      "let inspect = tool.define({ execute: (input) => tools.fs({ text: input }) })",
      "function sync() { return tools.github.issues({}) }",
    ].join("\n"),
  )

  expect(error.metadata).toMatchObject({ kind: "UnknownTool", tools: ["read", "fs", "github.issues"] })
  expect(error.message.split("\n\n")).toEqual([
    [
      "Unknown tool tools.read; this agent has no tool at that path. (line 1, col 30)",
      "Source: function load(path) { return tools.read({ text: path }) }",
      "Did you mean tools.fs.read?",
      'Check its exact signature with tools.search({ query: "tools.fs.read" })',
    ].join("\n"),
    [
      "Unknown tool tools.fs; this agent has no tool at that path. (line 2, col 49)",
      "Source: let inspect = tool.define({ execute: (input) => tools.fs({ text: input }) })",
      "tools.fs is a namespace; call one of its tools: tools.fs.read",
      'Find the right tool with tools.search({ query: "fs" }) and call the exact path it returns',
    ].join("\n"),
    [
      "Unknown tool tools.github.issues; this agent has no tool at that path. (line 3, col 26)",
      "Source: function sync() { return tools.github.issues({}) }",
      "Did you mean tools.linear.issues?",
      'Check its exact signature with tools.search({ query: "tools.linear.issues" })',
    ].join("\n"),
  ])
  expect(codemode.admitted).toEqual([])
})

test("unsupported syntax is refused with its position, source line, and a concrete rewrite", async () => {
  const codemode = setup([echo("read", "fs")])
  const error = await codemode.refuse(
    ['const file = tools.fs.read({ text: "log" })', "const errors = file.text.split(/\\r?\\n/)"].join("\n"),
  )

  expect(error.message).toBe(
    [
      "Regular expressions are not available; match text with string methods such as includes, startsWith, indexOf, slice, and split. (line 2, col 32)",
      "Source: const errors = file.text.split(/\\r?\\n/)",
      'Split lines with a string separator: file.text.split("\\n")',
    ].join("\n"),
  )
  expect(error.metadata).toEqual({
    executionStatus: "refused",
    kind: "UnsupportedSyntax",
    location: { line: 2, column: 32 },
    excerpt: "const errors = file.text.split(/\\r?\\n/)",
    suggestions: ['Split lines with a string separator: file.text.split("\\n")'],
  })
  expect(codemode.admitted).toEqual([])
})
