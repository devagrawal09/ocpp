import { describe, expect, test } from "bun:test"
import type {
  JsonValue,
  LocationRef,
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  ShellInfo,
} from "@ocpp/client/promise"
import { dict } from "@ocpp/ui/i18n/en"
import en from "@/runtime/i18n/en"
import { formatElapsed, lingerMs, linger, runningItems, type RunningItem } from "./session-running"

const location: LocationRef = { directory: "/repo" }

const assistant = (id: string, content: SessionMessageAssistantTool[]): SessionMessageAssistant => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content,
  time: { created: 100 },
})

const code = "\n  const found = await tools.grep({ pattern: 'TODO' })\nreturn found"

/** An `execute` call: still being admitted, or started with its execution's metadata. */
const execute = (id: string, metadata?: Record<string, JsonValue>): SessionMessageAssistantTool => ({
  type: "tool",
  id,
  name: "execute",
  state: metadata
    ? { status: "completed", input: { code }, content: [{ type: "text", text: "started" }], metadata }
    : { status: "running", input: { code }, metadata: {} },
  time: { created: 1_000, ran: 1_200 },
})

const session = (patch: Partial<SessionInfo> & { id: string }): SessionInfo => ({
  projectID: "prj",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1_500, updated: 1_500 },
  location,
  ...patch,
})

const shell = (patch: Partial<ShellInfo> & { id: string }): ShellInfo & { location: LocationRef } => ({
  status: "running",
  command: "bun test\n",
  cwd: "/repo",
  shell: "bash",
  file: "/tmp/out",
  metadata: { sessionID: "ses_parent" },
  time: { started: 2_000 },
  location,
  ...patch,
})

const derive = (input: {
  messages?: SessionMessageInfo[]
  sessions?: SessionInfo[]
  running?: string[]
  shells?: (ShellInfo & { location: LocationRef })[]
}) =>
  runningItems({
    sessionID: "ses_parent",
    messages: input.messages ?? [],
    sessions: input.sessions ?? [],
    status: (id) => (input.running?.includes(id) ? "running" : "idle"),
    shells: input.shells ?? [],
  })

describe("runningItems", () => {
  test("shows nothing for a session with no running work", () => {
    expect(derive({})).toEqual([])
    // Settled executions, idle children, and exited shells are not running.
    expect(
      derive({
        messages: [
          assistant("msg_a", [execute("call_done", { executionID: "exe_done", executionStatus: "completed" })]),
        ],
        sessions: [session({ id: "ses_child", parentID: "ses_parent" })],
        shells: [shell({ id: "sh_done", status: "exited" })],
      }),
    ).toEqual([])
  })

  test("lists a model's Code Mode execution with its progress", () => {
    const [item] = derive({
      messages: [
        assistant("msg_a", [
          execute("call_a", {
            executionID: "exe_a",
            executionStatus: "running",
            events: [
              { type: "tool", tool: "read", status: "completed", input: { path: "a.ts" } },
              { type: "trace", kind: "log", method: "log", message: "x" },
              { type: "tool", tool: "grep", status: "running", input: { pattern: "TODO" } },
            ],
          }),
        ]),
      ],
    })
    expect(item).toEqual({
      id: "call_a",
      kind: "execution",
      label: "const found = await tools.grep({ pattern: 'TODO' })",
      started: 1_200,
      steps: 3,
      tool: "grep",
      target: { messageID: "msg_a", partID: "call_a" },
      stop: { type: "execution", sessionID: "ses_parent", executionID: "exe_a" },
    })
  })

  test("keeps one item while an execution starts and then gets its ID", () => {
    const [starting] = derive({ messages: [assistant("msg_a", [execute("call_a")])] })
    expect(starting).toMatchObject({ id: "call_a", kind: "execution", steps: 0 })
    // It has nothing to cancel yet.
    expect(starting?.stop).toBeUndefined()
  })

  test("lists an event's run by its trigger", () => {
    const [item] = derive({
      messages: [
        {
          id: "msg_run",
          type: "invocation",
          trigger: { type: "event", name: "poll" },
          code: 'return poll({"event":"poll"})',
          executionID: "exe_run",
          status: "running",
          time: { created: 3_000 },
        },
      ],
    })
    expect(item).toMatchObject({
      id: "exe_run",
      trigger: { type: "event", name: "poll" },
      label: 'return poll({"event":"poll"})',
      target: { messageID: "msg_run" },
      stop: { type: "execution", sessionID: "ses_parent", executionID: "exe_run" },
    })
  })

  test("nests the subagents and shell commands an execution runs under it", () => {
    const items = derive({
      messages: [
        assistant("msg_a", [
          execute("call_a", {
            executionID: "exe_a",
            executionStatus: "running",
            events: [
              {
                type: "tool",
                tool: "subagent",
                status: "running",
                input: { agent: "explore", description: "Review the parser" },
                metadata: { sessionID: "ses_child", status: "running" },
              },
              {
                type: "tool",
                tool: "shell",
                status: "running",
                input: { command: "bun test" },
                metadata: { shellID: "sh_a" },
              },
            ],
          }),
        ]),
      ],
      sessions: [session({ id: "ses_child", parentID: "ses_parent", title: "Parser review", agent: "explore" })],
      shells: [shell({ id: "sh_a" })],
    })
    expect(items.map((item) => [item.id, item.parent])).toEqual([
      ["call_a", undefined],
      ["ses_child", "call_a"],
      ["sh_a", "call_a"],
    ])
    expect(items[1]).toMatchObject({
      kind: "subagent",
      label: "Review the parser",
      agent: "explore",
      title: "Parser review",
      // The child has no step in flight, so it waits on its own runs.
      working: false,
      started: 1_500,
      child: "ses_child",
      target: { messageID: "msg_a", partID: "call_a" },
      stop: { type: "subagent", sessionID: "ses_child" },
    })
    expect(items[2]).toMatchObject({
      kind: "shell",
      label: "bun test",
      target: { messageID: "msg_a", partID: "call_a" },
      stop: { type: "shell", shellID: "sh_a", location },
    })
  })

  test("lists work that runs on its own at the top level", () => {
    const items = derive({
      messages: [
        {
          id: "msg_shell",
          type: "shell",
          shellID: "sh_user",
          command: "npm run dev",
          status: "running",
          time: { created: 500 },
        },
      ],
      sessions: [
        session({ id: "ses_child", parentID: "ses_parent", title: "Background review", agent: "explore" }),
        // A fork is a copy of the session, not a subagent.
        session({
          id: "ses_fork",
          parentID: "ses_parent",
          fork: { sessionID: "ses_parent", boundary: { type: "through", messageID: "msg_a" } },
        }),
        session({ id: "ses_other", parentID: "ses_elsewhere" }),
      ],
      running: ["ses_child", "ses_fork", "ses_other"],
      shells: [
        shell({ id: "sh_user", command: "npm run dev", time: { started: 500 } }),
        shell({ id: "sh_other", metadata: { sessionID: "ses_elsewhere" } }),
      ],
    })
    expect(items).toEqual([
      {
        id: "sh_user",
        kind: "shell",
        label: "npm run dev",
        started: 500,
        target: { messageID: "msg_shell" },
        stop: { type: "shell", shellID: "sh_user", location },
      },
      {
        id: "ses_child",
        kind: "subagent",
        label: "Background review",
        agent: "explore",
        started: 1_500,
        working: true,
        child: "ses_child",
        stop: { type: "subagent", sessionID: "ses_child" },
      },
    ])
  })
})

describe("linger", () => {
  const item = (id: string, started: number): RunningItem => ({
    id,
    kind: "shell",
    label: id,
    started,
    stop: { type: "shell", shellID: id, location },
  })

  test("keeps a finished item briefly without its stop control", () => {
    const shown = linger([], [item("sh_a", 1), item("sh_b", 2)], 10_000)
    const after = linger(shown, [item("sh_b", 2)], 11_000)
    expect(after.map((entry) => [entry.id, entry.finished])).toEqual([
      ["sh_a", 11_000],
      ["sh_b", undefined],
    ])
    expect(after[0]?.stop).toBeUndefined()
    // The finish time holds while it lingers, and it leaves once the time is up.
    expect(linger(after, [item("sh_b", 2)], 11_000 + lingerMs - 1)[0]?.finished).toBe(11_000)
    expect(linger(after, [item("sh_b", 2)], 11_000 + lingerMs).map((entry) => entry.id)).toEqual(["sh_b"])
  })

  test("ends with the empty state once everything has finished", () => {
    const shown = linger([], [item("sh_a", 1)], 0)
    expect(linger(linger(shown, [], 1_000), [], 1_000 + lingerMs)).toEqual([])
  })
})

describe("formatElapsed", () => {
  const strings: Record<string, string> = { ...en, ...dict }
  const t = (key: string, params: Record<string, string | number>) =>
    (strings[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params[name]))

  test("grows from seconds to hours", () => {
    expect(formatElapsed(0, t)).toBe("0s")
    expect(formatElapsed(59_999, t)).toBe("59s")
    expect(formatElapsed(125_000, t)).toBe("2m 05s")
    expect(formatElapsed(3_725_000, t)).toBe("1h 02m")
    // A clock that runs behind never shows a negative time.
    expect(formatElapsed(-5_000, t)).toBe("0s")
  })
})
