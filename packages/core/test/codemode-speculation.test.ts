import { describe, expect, test } from "bun:test"
import { CodeMode } from "@ocpp/codemode"
import type { CodeModeStore } from "@ocpp/core/codemode/store"
import type { CodeModeSpeculation } from "@ocpp/core/codemode/speculation"
import { CodeModeTool } from "@ocpp/core/codemode/tool"
import { limits } from "@ocpp/core/codemode/limits"
import { Tool } from "@ocpp/core/tool"
import { execute } from "@ocpp/core/tool/runtime"
import { Agent } from "@ocpp/schema/agent"
import { ascending } from "@ocpp/schema/identifier"
import { Session } from "@ocpp/schema/session"
import { SessionMessage } from "@ocpp/schema/session-message"
import type { Info } from "@ocpp/schema/tool"
import { Deferred, Duration, Effect, Exit, Fiber, Schema, Scope } from "effect"

const context = {
  sessionID: Session.ID.make("ses_speculation"),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_speculation"),
  id: Tool.CallID.make("call_spec"),
  progress: () => Effect.void,
}

const on: CodeModeSpeculation.Caps = { maxSpeculativeCalls: 8, maxSpeculativeCallsPerExecution: 64 }
// Speculation is on by default, so a run without it disables it explicitly.
const disabled: CodeModeSpeculation.Caps = { maxSpeculativeCalls: 0, maxSpeculativeCallsPerExecution: 0 }

/** Tools over a small key-value world that record every run, its overlap, and its interruption. */
const world = (delay = 10) => {
  const state = new Map([
    ["a", "A"],
    ["b", "B"],
    ["c", "C"],
    ["k", "old"],
  ])
  const ran: Array<string> = []
  const interrupted: Array<string> = []
  let active = 0
  let peak = 0
  const tools: ReadonlyArray<Info> = [
    {
      name: "lookup",
      options: { readOnly: true },
      description: "Reads a key.",
      input: Schema.Struct({ key: Schema.String }),
      output: Schema.Struct({ value: Schema.String }),
      execute: (input: { readonly key: string }) =>
        Effect.gen(function* () {
          ran.push("lookup:" + input.key)
          // The value is read when the call starts, so a read started before a write sees the old value.
          const value = state.get(input.key) ?? "none"
          active++
          peak = Math.max(peak, active)
          yield* Effect.sleep(Duration.millis(delay)).pipe(Effect.ensuring(Effect.sync(() => active--)))
          if (input.key === "boom") return yield* new Tool.Error({ message: "lookup failed" })
          return { output: { value } }
        }),
    },
    {
      name: "write",
      description: "Writes a key.",
      input: Schema.Struct({ key: Schema.String, value: Schema.String }),
      output: Schema.Struct({ ok: Schema.Boolean }),
      execute: (input: { readonly key: string; readonly value: string }) =>
        Effect.sync(() => {
          ran.push("write:" + input.key)
          state.set(input.key, input.value)
          return { output: { ok: true } }
        }),
    },
    {
      name: "slow",
      options: { readOnly: true },
      description: "Never finishes.",
      input: Schema.Struct({ n: Schema.Number }),
      output: Schema.Struct({ n: Schema.Number }),
      execute: (input: { readonly n: number }) =>
        Effect.sync(() => ran.push("slow:" + input.n)).pipe(
          Effect.andThen(Effect.never as Effect.Effect<{ readonly output: { readonly n: number } }>),
          Effect.onInterrupt(() => Effect.sync(() => void interrupted.push("slow:" + input.n))),
        ),
    },
  ]
  return { tools, ran, interrupted, state, peak: () => peak }
}

type Entry = CodeModeStore.JournalEntry

/**
 * Runs a program through the real execution path, from the replay gateway to the journal hooks, with
 * in-memory services. A journal makes it a resumed run; an empty one runs everything live.
 */
const start = (
  code: string,
  tools: ReadonlyArray<Info>,
  options: {
    readonly speculation?: CodeModeSpeculation.Caps
    readonly journal?: ReadonlyArray<Entry>
    readonly intercepted?: boolean
    readonly executionID?: string
  } = {},
) => {
  const events: Array<string> = []
  const journal = new Map<number, Entry>()
  let declarations: Readonly<Record<string, unknown>> | undefined
  let fiber: Fiber.Fiber<string, Error> | undefined
  const scope = Effect.runSync(Scope.make())
  const registrations = new Map(tools.map((tool) => [tool.name, tool] as const))
  const executeTool = (_name: string, tool: Info, input: unknown, call: Tool.Context) =>
    Effect.suspend(() => {
      events.push("invoke:" + call.id.slice(context.id.length + 1))
      return execute(tool, input, call)
    })
  const services = {
    bus: { publish: () => Effect.succeed(undefined as never), listen: () => Effect.succeed(Effect.void) },
    jobs: {
      startLimited: (input: { readonly id?: string; readonly run: Effect.Effect<string, Error> }) =>
        Effect.gen(function* () {
          fiber = yield* input.run.pipe(Effect.forkIn(scope))
          return { id: input.id ?? "exe", type: "codemode", status: "running" as const, started_at: 0 }
        }),
      active: () => Effect.succeed([]),
      wait: () => Effect.never,
      background: () => Effect.succeed(undefined),
      cancel: () => Effect.succeed(undefined),
      markBackgroundTerminal: () => Effect.void,
      completeBackground: () => Effect.void,
    },
    sessions: { message: () => Effect.succeed(undefined), synthetic: () => Effect.die("Unused") },
    store: {
      admit: () => Effect.die("Unused: the execution is already admitted"),
      running: () => Effect.void,
      scheduleCall: (input: { index: number; tool: string; input: unknown; impure?: ReadonlyArray<number> }) =>
        Effect.sync(() => {
          events.push("schedule:" + input.index)
          journal.set(input.index, {
            index: input.index,
            tool: input.tool,
            input: input.input,
            status: "scheduled",
            output: undefined,
            error: undefined,
            omitted: false,
            impure: input.impure ?? [],
            progress: undefined,
          })
        }),
      progressCall: () => Effect.void,
      settleCall: (input: { index: number; outcome: Entry["status"]; output?: unknown; error?: string }) =>
        Effect.sync(() => {
          const entry = journal.get(input.index)
          if (entry !== undefined)
            journal.set(input.index, { ...entry, status: input.outcome, output: input.output, error: input.error })
        }),
      commit: (_execution: unknown, values: Readonly<Record<string, unknown>>) =>
        Effect.sync(() => {
          declarations = values
          return { status: "saved" as const, saved: Object.keys(values) }
        }),
      fail: () => Effect.void,
      discard: () => Effect.void,
      indeterminate: () => Effect.void,
    },
    image: { normalize: () => Effect.die("No tool returns media in these tests") },
    scope,
  }
  const refused = Effect.runSync(
    CodeModeTool.resume(registrations, executeTool, services as never, {
      context,
      resumable: {
        execution: {
          id: options.executionID ?? "exe_" + ascending(),
          sessionID: context.sessionID,
          assistantMessageID: context.messageID,
          toolCallID: context.id,
          program: CodeMode.compile(code),
          bindings: {},
        },
        journal: options.journal ?? [],
        resumes: 1,
        missing: [],
      },
      notificationID: SessionMessage.ID.create(),
      lent: new Set(),
      ...(options.speculation === undefined ? {} : { speculation: options.speculation }),
      intercepted: Effect.succeed(options.intercepted ?? false),
    }),
  )
  expect(refused).toBeUndefined()
  const running = fiber
  if (running === undefined) throw new Error("The execution did not start")
  return {
    fiber: running,
    events,
    /** Settled outcome: the summary, and whether the program saved. */
    settled: async () => {
      const exit = await Effect.runPromise(Fiber.await(running))
      return Exit.isSuccess(exit)
        ? { saved: true, summary: exit.value }
        : { saved: false, summary: String(Exit.isFailure(exit) ? exit.cause : "") }
    },
    journal: () => Array.from(journal.values()).sort((left, right) => left.index - right.index),
    declarations: () => declarations,
    /** Calls a tool ran for before the program reached them, read off the event order. */
    speculative: () =>
      events.flatMap((event) => {
        if (!event.startsWith("invoke:")) return []
        const index = event.slice("invoke:".length)
        return events.indexOf("schedule:" + index) > events.indexOf(event) || !events.includes("schedule:" + index)
          ? [Number(index)]
          : []
      }),
  }
}

const run = async (code: string, tools: ReadonlyArray<Info>, options: Parameters<typeof start>[2] = {}) => {
  const execution = start(code, tools, options)
  const outcome = await execution.settled()
  return { ...execution, outcome }
}

/** The journal as replay compares it, with each call's impure values reduced to their count. */
const comparable = (journal: ReadonlyArray<Entry>) =>
  journal.map((entry) => ({
    index: entry.index,
    tool: entry.tool,
    input: entry.input,
    status: entry.status,
    output: entry.output,
    error: entry.error,
    impure: entry.impure.length,
  }))

const until = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 1000 && !check(); attempt++) await Bun.sleep(2)
  expect(check()).toBe(true)
}

const lines = (...source: ReadonlyArray<string>) => source.join("\n")

const programs = {
  independent: lines(
    'const a = tools.lookup({ key: "a" })',
    'const b = tools.lookup({ key: "b" })',
    'const c = tools.lookup({ key: "c" })',
  ),
  readAfterWrite: lines(
    'const before = tools.lookup({ key: "k" })',
    'const wrote = tools.write({ key: "k", value: "new" })',
    'const after = tools.lookup({ key: "k" })',
  ),
  mixed: lines(
    "function read(key) { return tools.lookup({ key }) }",
    'const first = tools.lookup({ key: "a" })',
    "let at = time.now()",
    'const viaHelper = read("b")',
    "let total = 0",
    'for (const key of ["a", "b"]) { total = total + tools.lookup({ key }).value.length }',
    "let rolled = Math.random()",
    'let caught = "none"',
    'try { tools.lookup({ key: "boom" }) } catch (error) { caught = error.message }',
    'const same1 = tools.lookup({ key: "c" })',
    'const same2 = tools.lookup({ key: "c" })',
    'const labelled = tools.lookup({ key: `${first.value}`.toLowerCase === undefined ? "x" : "c" })',
    "const report = { first, viaHelper, total, caught, same1, same2, at: typeof at, rolled: typeof rolled }",
  ),
  failing: lines(
    'const a = tools.lookup({ key: "a" })',
    'if (a.value === "A") throw new Error("stop")',
    'const never = tools.lookup({ key: "b" })',
  ),
}

describe("Code Mode speculation", () => {
  test("is on by default with bounded caps", () => {
    expect(limits.maxSpeculativeCalls).toBe(8)
    expect(limits.maxSpeculativeCallsPerExecution).toBe(32)
  })

  test("a run with speculation gives the same results, notebook values and journal as one without", async () => {
    for (const [name, code] of Object.entries(programs)) {
      const executionID = "exe_" + ascending()
      const offWorld = world()
      const onWorld = world()
      const off = await run(code, offWorld.tools, { executionID, speculation: disabled })
      const speculated = await run(code, onWorld.tools, { executionID, speculation: on })
      expect({ name, outcome: speculated.outcome }).toEqual({ name, outcome: off.outcome })
      expect(speculated.declarations()).toEqual(off.declarations())
      expect(comparable(speculated.journal())).toEqual(comparable(off.journal()))
      expect(off.speculative()).toEqual([])
      // A program that stops early may leave a started call unconsumed; every other run does the same work.
      if (name !== "failing") expect([...onWorld.ran].sort()).toEqual([...offWorld.ran].sort())
    }
  })

  test("a hit serves the started result without running the tool again", async () => {
    const tools = world()
    const result = await run(programs.independent, tools.tools, { speculation: on })
    expect(result.outcome.saved).toBe(true)
    expect(result.declarations()).toEqual({ a: { value: "A" }, b: { value: "B" }, c: { value: "C" } })
    // Each call ran exactly once, all three overlapped, and the later two started before the program
    // reached them. The first is proposed right before it runs, so it may start just after its start hook.
    expect([...tools.ran].sort()).toEqual(["lookup:a", "lookup:b", "lookup:c"])
    expect(result.events.filter((event) => event.startsWith("invoke:")).sort()).toEqual([
      "invoke:0",
      "invoke:1",
      "invoke:2",
    ])
    expect(result.speculative()).toEqual(expect.arrayContaining([1, 2]))
    expect(tools.peak()).toBe(3)
  })

  test("a later read starts while an earlier one is still blocked, and runs once", async () => {
    const releaseFirst = Effect.runSync(Deferred.make<void>())
    const secondStarted = Effect.runSync(Deferred.make<void>())
    const runs: Array<string> = []
    const gated: ReadonlyArray<Info> = [
      {
        name: "first",
        options: { readOnly: true },
        description: "Blocks until released.",
        input: Schema.Struct({}),
        output: Schema.Struct({ value: Schema.String }),
        execute: () =>
          Effect.sync(() => runs.push("first")).pipe(
            Effect.andThen(Deferred.await(releaseFirst)),
            Effect.as({ output: { value: "A" } }),
          ),
      },
      {
        name: "second",
        options: { readOnly: true },
        description: "Signals when it starts.",
        input: Schema.Struct({}),
        output: Schema.Struct({ value: Schema.String }),
        execute: () =>
          Effect.sync(() => runs.push("second")).pipe(
            Effect.andThen(Deferred.succeed(secondStarted, undefined)),
            Effect.as({ output: { value: "B" } }),
          ),
      },
    ]
    const execution = start(lines("const a = tools.first({})", "const b = tools.second({})"), gated, {
      speculation: on,
    })
    // The program is blocked on the first call, yet the second has already started.
    await Effect.runPromise(Deferred.await(secondStarted))
    expect(Effect.runSync(Deferred.isDone(releaseFirst))).toBe(false)
    expect(execution.events).not.toContain("schedule:1")
    await Effect.runPromise(Deferred.succeed(releaseFirst, undefined))
    const outcome = await execution.settled()
    expect(outcome.saved).toBe(true)
    expect(execution.declarations()).toEqual({ a: { value: "A" }, b: { value: "B" } })
    expect(runs.filter((run) => run === "second")).toHaveLength(1)
    expect(execution.journal().map((entry) => [entry.tool, entry.status, entry.output])).toEqual([
      ["first", "completed", { value: "A" }],
      ["second", "completed", { value: "B" }],
    ])
  })

  test("a read after a write is never served a result computed before the write", async () => {
    const tools = world()
    const result = await run(programs.readAfterWrite, tools.tools, { speculation: on })
    expect(result.declarations()).toEqual({
      before: { value: "old" },
      wrote: { ok: true },
      after: { value: "new" },
    })
    expect(tools.ran).toEqual(["lookup:k", "write:k", "lookup:k"])
    expect(result.events.indexOf("invoke:2")).toBeGreaterThan(result.events.indexOf("schedule:1"))
  })

  test("does not speculate past a user or notebook function call or an impure helper", async () => {
    const helper = world()
    const viaFunction = await run(
      lines(
        'function touch() { return tools.write({ key: "b", value: "changed" }) }',
        'const a = tools.lookup({ key: "a" })',
        "touch()",
        'const b = tools.lookup({ key: "b" })',
      ),
      helper.tools,
      { speculation: on },
    )
    expect(viaFunction.declarations()).toMatchObject({ a: { value: "A" }, b: { value: "changed" } })
    expect(helper.ran).toEqual(["lookup:a", "write:b", "lookup:b"])

    for (const impure of ["let at = time.now()", "let rolled = Math.random()"]) {
      const clock = world()
      const result = await run(
        lines('const a = tools.lookup({ key: "a" })', impure, 'const b = tools.lookup({ key: "b" })'),
        clock.tools,
        { speculation: on },
      )
      expect(result.outcome.saved).toBe(true)
      // b never overlapped a, so it did not start before the impure read.
      expect(clock.peak()).toBe(1)
    }
  })

  test("identical calls are two entries, run twice, and each consumed once", async () => {
    const tools = world()
    const result = await run(
      lines('const x1 = tools.lookup({ key: "a" })', 'const x2 = tools.lookup({ key: "a" })'),
      tools.tools,
      { speculation: on },
    )
    expect(result.declarations()).toEqual({ x1: { value: "A" }, x2: { value: "A" } })
    expect(tools.ran).toEqual(["lookup:a", "lookup:a"])
    expect(result.speculative()).toEqual(expect.arrayContaining([1]))
    expect(result.events.filter((event) => event.startsWith("invoke:"))).toEqual(["invoke:0", "invoke:1"])
    expect(tools.peak()).toBe(2)
  })

  test("calls over the caps are dropped without blocking the program", async () => {
    const code = lines(...["a", "b", "c", "k"].map((key) => `const v_${key} = tools.lookup({ key: "${key}" })`))
    for (const caps of [
      { maxSpeculativeCalls: 1, maxSpeculativeCallsPerExecution: 2 },
      { maxSpeculativeCalls: 1, maxSpeculativeCallsPerExecution: 1 },
      { maxSpeculativeCalls: 2, maxSpeculativeCallsPerExecution: 64 },
    ]) {
      const tools = world()
      const result = await run(code, tools.tools, { speculation: caps })
      expect(result.declarations()).toEqual({
        v_a: { value: "A" },
        v_b: { value: "B" },
        v_c: { value: "C" },
        v_k: { value: "old" },
      })
      expect(tools.ran).toHaveLength(4)
      expect(result.speculative().length).toBeLessThanOrEqual(caps.maxSpeculativeCallsPerExecution)
      // A consumed call no longer counts as held, so at most one more than the cap overlaps.
      expect(tools.peak()).toBeLessThanOrEqual(caps.maxSpeculativeCalls + 1)
    }
    expect(() =>
      start(code, world().tools, { speculation: { maxSpeculativeCalls: -1, maxSpeculativeCallsPerExecution: 1 } }),
    ).toThrow("maxSpeculativeCalls must be a non-negative safe integer")
  })

  test("speculation does not count against maxToolCalls", async () => {
    const calls = (count: number) =>
      lines(...Array.from({ length: count }, (_, index) => `tools.lookup({ key: "k${index}" })`))
    const atLimit = await run(calls(limits.maxToolCalls), world(0).tools, { speculation: on })
    expect(atLimit.outcome.saved).toBe(true)
    expect(atLimit.speculative().length).toBeGreaterThan(0)
    const executionID = "exe_" + ascending()
    const over = await run(calls(limits.maxToolCalls + 1), world(0).tools, { speculation: on, executionID })
    const overOff = await run(calls(limits.maxToolCalls + 1), world(0).tools, { executionID, speculation: disabled })
    expect(over.outcome).toEqual(overOff.outcome)
    expect(over.outcome.summary).toContain("tool-call limit of " + limits.maxToolCalls)
    expect(over.journal()).toHaveLength(limits.maxToolCalls)
  })

  test("an unconsumed call is interrupted when the program succeeds, fails, or is interrupted", async () => {
    for (const stop of ['if (a.value === "A") return 1', 'if (a.value === "A") throw new Error("stop")']) {
      const tools = world()
      const result = await run(
        lines('const a = tools.lookup({ key: "a" })', stop, "tools.slow({ n: 1 })"),
        tools.tools,
        { speculation: on },
      )
      expect(tools.ran).toContain("slow:1")
      expect(tools.interrupted).toEqual(["slow:1"])
      expect(result.journal().map((entry) => entry.tool)).toEqual(["lookup"])
    }

    const tools = world()
    const execution = start(lines("const s1 = tools.slow({ n: 1 })", "const s2 = tools.slow({ n: 2 })"), tools.tools, {
      speculation: on,
    })
    await until(() => tools.ran.includes("slow:1") && tools.ran.includes("slow:2"))
    await Effect.runPromise(Fiber.interrupt(execution.fiber))
    expect([...tools.interrupted].sort()).toEqual(["slow:1", "slow:2"])
  })

  test("starts nothing while a plugin hook can observe or refuse tool calls", async () => {
    const tools = world()
    const result = await run(programs.independent, tools.tools, { speculation: on, intercepted: true })
    expect(result.outcome.saved).toBe(true)
    expect(tools.peak()).toBe(1)
    expect(result.events.filter((event) => event.startsWith("invoke:"))).toEqual(["invoke:0", "invoke:1", "invoke:2"])
    expect(result.events.indexOf("invoke:1")).toBeGreaterThan(result.events.indexOf("schedule:1"))
  })

  test("a journal written with speculation replays identically", async () => {
    const code = lines(
      'const first = tools.lookup({ key: "a" })',
      "const at = time.now()",
      'const second = tools.lookup({ key: "b" })',
      'const third = tools.lookup({ key: String(at).length > 0 ? "c" : "a" })',
    )
    const original = await run(code, world().tools, { speculation: on })
    expect(original.outcome.saved).toBe(true)
    const journal = original.journal()
    expect(journal.map((entry) => [entry.tool, entry.status, entry.impure.length])).toEqual([
      ["lookup", "completed", 0],
      ["lookup", "completed", 1],
      ["lookup", "completed", 0],
    ])

    const replayed = world()
    const full = await run(code, replayed.tools, { speculation: on, journal })
    expect(full.outcome.saved).toBe(true)
    expect(full.outcome.summary).toContain("replayed 3 journaled tool calls")
    expect(replayed.ran).toEqual([])
    expect(full.declarations()).toEqual(original.declarations())

    const partial = world()
    const resumed = await run(code, partial.tools, { speculation: on, journal: journal.slice(0, 2) })
    expect(resumed.outcome.saved).toBe(true)
    expect(partial.ran).toEqual(["lookup:c"])
    expect(resumed.declarations()).toEqual(original.declarations())
    // The live tail is journaled exactly as the original run journaled it.
    expect(comparable(resumed.journal().slice(2))).toEqual(comparable(journal.slice(2)))
    expect(resumed.journal().map((entry) => [entry.tool, entry.input, entry.output])).toEqual(
      journal.map((entry) => [entry.tool, entry.input, entry.output]),
    )
  })
})
