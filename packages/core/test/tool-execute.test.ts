import { expect, test } from "bun:test"
import { CodeModeTool } from "@ocpp/core/codemode/tool"
import { Tool } from "@ocpp/core/tool"
import { execute } from "@ocpp/core/tool/runtime"
import { Agent } from "@ocpp/schema/agent"
import { Session } from "@ocpp/schema/session"
import { NotFoundError } from "@ocpp/core/session/error"
import { SessionMessage } from "@ocpp/schema/session-message"
import type { Info } from "@ocpp/schema/tool"
import { Effect, Schema, Scope } from "effect"

const context = {
  sessionID: Session.ID.make("ses_execute"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_execute"),
  id: Tool.CallID.make("call_execute"),
  progress: () => Effect.void,
}

const createCodeMode = (tools: ReadonlyMap<string, Info>) =>
  CodeModeTool.create(tools, (_, tool, input, context) => execute(tool, input, context), {
    bus: {
      publish: () => Effect.die("Unavailable in catalog-only tests"),
      listen: () => Effect.die("Unavailable in catalog-only tests"),
    },
    jobs: {
      startLimited: () => Effect.die("Unavailable in catalog-only tests"),
      active: () => Effect.die("Unavailable in catalog-only tests"),
      wait: () => Effect.die("Unavailable in catalog-only tests"),
      background: () => Effect.die("Unavailable in catalog-only tests"),
      cancel: () => Effect.die("Unavailable in catalog-only tests"),
      markBackgroundTerminal: () => Effect.die("Unavailable in catalog-only tests"),
      completeBackground: () => Effect.die("Unavailable in catalog-only tests"),
    },
    sessions: {
      message: () => Effect.die("Unavailable in catalog-only tests"),
      synthetic: () => Effect.die("Unavailable in catalog-only tests"),
    },
    store: {
      admit: () => Effect.die("Unavailable in catalog-only tests"),
      running: () => Effect.die("Unavailable in catalog-only tests"),
      scheduleCall: () => Effect.die("Unavailable in catalog-only tests"),
      progressCall: () => Effect.die("Unavailable in catalog-only tests"),
      settleCall: () => Effect.die("Unavailable in catalog-only tests"),
      commit: () => Effect.die("Unavailable in catalog-only tests"),
      fail: () => Effect.die("Unavailable in catalog-only tests"),
      discard: () => Effect.die("Unavailable in catalog-only tests"),
      indeterminate: () => Effect.die("Unavailable in catalog-only tests"),
    },
    image: { normalize: () => Effect.die("No tool returns media in these tests") },
    scope: Effect.runSync(Scope.make()),
  })

test("execute describes invariant Code Mode behavior", () => {
  expect(createCodeMode(new Map()).description).toBe(
    [
      "Run a JavaScript-shaped program that calls tools and composes their results.",
      "Tool calls block and return values directly. await and Promise.all are accepted only as ignored compatibility no-ops that produce a warning; do not use them. Other Promise forms, async, generators, dynamic tool dispatch, imports, filesystem access, fetch, and timers are unavailable.",
      "Calls within one execution always run serially, including subagent calls. To run independent subagents concurrently, issue one execute call per subagent; never put parallel subagent work in the same execution.",
      "Call only exact static paths from the catalog, for example tools.fs.read(input).",
      "Use local let for scalar working state. Arrays and objects are immutable; use map, filter, slice, spread, and object literals to derive values.",
      "Every direct top-level const and function declaration is saved to the durable notebook automatically and is visible to later executions. Declarations inside blocks and functions are temporary.",
      "Notebook names are immutable: a name can never be redefined or reused. Saving is all-or-nothing, so a failed program saves nothing.",
      "return is only a small preview for display and may be truncated; publish real output as top-level declarations.",
      "Execution is asynchronous: this call returns an execution ID immediately and the result arrives as a later notification.",
      "At most 10 executions may run at once per Session, including executions that are waiting on subagents. A refused call names the running executions; wait for one of their completion notifications before starting another instead of retrying immediately.",
    ].join("\n"),
  )
})

test("a compile failure is refused with its diagnostic kind, position, and excerpt as metadata", async () => {
  const error = await Effect.runPromise(
    createCodeMode(new Map())
      .execute({ code: ["const a = 1", "const b = {,}", "return b"].join("\n") }, context)
      .pipe(Effect.flip),
  )
  expect(error).toBeInstanceOf(Tool.Error)
  expect(error.metadata).toEqual({
    executionStatus: "refused",
    kind: "ParseError",
    location: { line: 2, column: 12 },
    excerpt: "const b = {,}",
  })
  expect(error.message).toBe(
    ["Failed to parse TypeScript: Property assignment expected. (line 2, col 12)", "Source: const b = {,}"].join("\n"),
  )
})

test("a refused execution names the running executions instead of only the cap", async () => {
  const discarded: string[] = []
  const codemode = CodeModeTool.create(new Map(), () => Effect.die("No tools are exposed"), {
    bus: {
      publish: () => Effect.succeed(undefined as never),
      listen: () => Effect.succeed(Effect.void),
    },
    jobs: {
      // The Session already holds every slot, so admission is refused.
      startLimited: () => Effect.succeed(undefined),
      active: (input) =>
        Effect.succeed(
          ["exe_first", "exe_second"].map((id) => ({
            id,
            type: input.type ?? "codemode",
            status: "running" as const,
            started_at: 0,
          })),
        ),
      wait: () => Effect.die("Unreached: the execution was refused"),
      background: () => Effect.die("Unreached: the execution was refused"),
      cancel: () => Effect.succeed(undefined),
      markBackgroundTerminal: () => Effect.void,
      completeBackground: () => Effect.void,
    },
    sessions: {
      message: () => Effect.succeed(undefined),
      synthetic: () => Effect.die("Unreached: the execution was refused"),
    },
    store: {
      admit: (input) => Effect.succeed({ ok: true, execution: { ...input, bindings: {} } }),
      running: () => Effect.void,
      scheduleCall: () => Effect.void,
      progressCall: () => Effect.void,
      settleCall: () => Effect.void,
      commit: () => Effect.die("Unreached: the execution was refused"),
      fail: () => Effect.void,
      discard: (id) => Effect.sync(() => void discarded.push(id)),
      indeterminate: () => Effect.void,
    },
    image: { normalize: () => Effect.die("No tool returns media in these tests") },
    scope: Effect.runSync(Scope.make()),
  })

  const error = await Effect.runPromise(codemode.execute({ code: "return 1" }, context).pipe(Effect.flip))
  expect(error).toBeInstanceOf(Tool.Error)
  expect(error.message).toBe(
    "At most 10 executions may run per Session, and 2 are running: exe_first, exe_second. Wait for one of their completion notifications before starting another execution; do not retry immediately.",
  )
  expect(error.metadata).toEqual({
    executionStatus: "refused",
    kind: "ConcurrencyLimit",
    limit: 10,
    active: ["exe_first", "exe_second"],
  })
  // The reserved names are released, so the refused program holds nothing.
  expect(discarded).toHaveLength(1)
})

test("a failed execution's completion carries a stable failure kind in its metadata", async () => {
  const notificationID = SessionMessage.ID.create()
  const delivered: unknown[] = []
  let finish: () => void = () => {}
  const finished = new Promise<void>((resolve) => (finish = resolve))
  const codemode = CodeModeTool.create(new Map(), () => Effect.die("No tools are exposed"), {
    bus: {
      publish: () => Effect.succeed(undefined as never),
      listen: () => Effect.succeed(Effect.void),
    },
    jobs: {
      startLimited: (input) =>
        Effect.succeed({ id: input.id ?? "exe", type: "codemode", status: "running", started_at: 0 }),
      active: () => Effect.succeed([]),
      // The job settled as an error before the program ran, as a restart or cancellation would.
      wait: () =>
        Effect.succeed({
          info: {
            id: "exe",
            type: "codemode",
            status: "error",
            started_at: 0,
            notificationID,
            error: "Execution failed",
          },
          timedOut: false,
        }),
      background: () => Effect.succeed(undefined),
      cancel: () => Effect.succeed(undefined),
      markBackgroundTerminal: () => Effect.void,
      completeBackground: () => Effect.sync(finish),
    },
    sessions: {
      message: () => Effect.succeed(undefined),
      synthetic: (input) =>
        Effect.sync(() => {
          delivered.push(input.metadata)
          return { id: notificationID } as never
        }),
    },
    store: {
      admit: (input) => Effect.succeed({ ok: true, execution: { ...input, bindings: {} } }),
      running: () => Effect.void,
      scheduleCall: () => Effect.void,
      progressCall: () => Effect.void,
      settleCall: () => Effect.void,
      commit: () => Effect.die("Unreached: the job never runs the program here"),
      fail: () => Effect.void,
      discard: () => Effect.void,
      indeterminate: () => Effect.void,
    },
    image: { normalize: () => Effect.die("No tool returns media in these tests") },
    scope: Effect.runSync(Scope.make()),
  })

  await Effect.runPromise(codemode.execute({ code: "const saved = 1" }, context))
  await finished
  expect(delivered).toEqual([{ source: "codemode", executionID: "exe", state: "failed", kind: "ExecutionFailure" }])
})

test("execute accepts source code only", () => {
  const input = createCodeMode(new Map()).input
  expect(Schema.decodeUnknownSync(input)({ code: "return 1" })).toEqual({ code: "return 1" })
  // Mode and timeout are host-owned: an execution cannot request either.
  expect(Schema.decodeUnknownSync(input)({ code: "return 1", mode: "detached", timeoutMs: 1000 })).toEqual({
    code: "return 1",
  })
})

test("canonical execution distinguishes declared, model-only, and raw schema outputs", async () => {
  const declared: Info = {
    name: "declared",
    description: "Declared",
    input: Schema.Struct({ value: Schema.String }),
    output: Schema.Struct({ value: Schema.String }),
    execute: ({ value }) => Effect.succeed({ output: { value } }),
  }
  const modelOnlyInput = Schema.Struct({})
  const modelOnly = {
    name: "model_only",
    description: "Model only",
    input: modelOnlyInput,
    execute: () => Effect.succeed({ content: "visible only", metadata: { kind: "model" } }),
  } satisfies Info<typeof modelOnlyInput, undefined>
  const raw: Info = {
    name: "raw",
    description: "Raw",
    input: {},
    output: {},
    execute: (input) => Effect.succeed({ output: input, content: "raw" }),
  }

  expect(await Effect.runPromise(execute(declared, { value: "encoded" }, context))).toEqual({
    output: { value: "encoded" },
    content: [{ type: "text", text: '{"value":"encoded"}' }],
  })
  expect(await Effect.runPromise(execute(modelOnly, {}, context))).toEqual({
    output: undefined,
    content: [{ type: "text", text: "visible only" }],
    metadata: { kind: "model" },
  })
  expect(await Effect.runPromise(execute(raw, { unchecked: true }, context))).toEqual({
    output: { unchecked: true },
    content: [{ type: "text", text: "raw" }],
  })
})

test("declared outputs cannot bypass validation and raw outputs stay JSON-compatible", async () => {
  const missing: Info = {
    name: "missing",
    description: "Missing output",
    input: Schema.Struct({}),
    output: Schema.String,
    execute: () => Effect.succeed({ content: "not an output" }),
  }
  const invalid: Info = {
    name: "invalid",
    description: "Invalid raw output",
    input: {},
    output: {},
    execute: () => Effect.succeed({ output: 1n, content: "not JSON" }),
  }

  expect((await Effect.runPromiseExit(execute(missing, {}, context))).toString()).toContain(
    "Tool did not return its declared output",
  )
  expect((await Effect.runPromiseExit(execute(invalid, {}, context))).toString()).toContain(
    "Tool returned a non-JSON value",
  )
})

test("a Session deleted mid-execution still finishes the background notification", async () => {
  const notificationID = SessionMessage.ID.create()
  const completed: string[] = []
  let finish: () => void = () => {}
  const finished = new Promise<void>((resolve) => (finish = resolve))
  const codemode = CodeModeTool.create(new Map(), () => Effect.die("No tools are exposed"), {
    bus: {
      publish: () => Effect.succeed(undefined as never),
      listen: () => Effect.succeed(Effect.void),
    },
    jobs: {
      startLimited: (input) =>
        Effect.succeed({ id: input.id ?? "exe", type: "codemode", status: "running", started_at: 0 }),
      active: () => Effect.succeed([]),
      wait: () =>
        Effect.succeed({
          info: { id: "exe", type: "codemode", status: "completed", started_at: 0, notificationID },
          timedOut: false,
        }),
      background: () => Effect.succeed(undefined),
      cancel: () => Effect.succeed(undefined),
      markBackgroundTerminal: () => Effect.void,
      completeBackground: (id) =>
        Effect.sync(() => {
          completed.push(id)
          finish()
        }),
    },
    sessions: {
      message: () => Effect.succeed(undefined),
      // The Session was deleted while the execution ran.
      synthetic: () => Effect.fail(new NotFoundError({ sessionID: context.sessionID })),
    },
    store: {
      admit: (input) => Effect.succeed({ ok: true, execution: { ...input, bindings: {} } }),
      running: () => Effect.void,
      scheduleCall: () => Effect.void,
      progressCall: () => Effect.void,
      settleCall: () => Effect.void,
      commit: () => Effect.die("Unreached: the job never runs the program here"),
      fail: () => Effect.void,
      discard: () => Effect.void,
      indeterminate: () => Effect.void,
    },
    image: { normalize: () => Effect.die("No tool returns media in these tests") },
    scope: Effect.runSync(Scope.make()),
  })

  const result = await Effect.runPromise(codemode.execute({ code: "const saved = 1" }, context))
  await finished

  expect(result).toMatchObject({ output: { status: "running" } })
  expect(completed).toEqual([notificationID])
})

test("foreign typed failures settle as Tool.Error at the untrusted boundary", async () => {
  class ForeignFailure extends Schema.TaggedError<ForeignFailure>()("Plugin.ForeignFailure", {
    message: Schema.String,
  }) {}
  const lying: Info = {
    name: "lying",
    description: "Fails with a non-Tool.Error typed failure",
    input: Schema.Struct({}),
    execute: () => new ForeignFailure({ message: "transport died" }) as never,
  }

  const error = await Effect.runPromise(execute(lying, {}, context).pipe(Effect.flip))
  expect(error).toBeInstanceOf(Tool.Error)
  expect(error.message).toBe("transport died")
})
