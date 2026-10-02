import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@ocpp/client/promise"
import { Timeline, TimelineRow } from "./projection"

const messages: SessionMessageInfo[] = [
  { id: "user-1", type: "user", text: "hello", time: { created: 1 } },
  {
    id: "assistant-1",
    type: "assistant",
    agent: "build",
    model: { id: "model", providerID: "provider" },
    content: [{ type: "text", text: "hi" }],
    time: { created: 2, completed: 3 },
  },
  {
    id: "invocation-1",
    type: "invocation",
    trigger: { type: "command", name: "triage", text: "login fails" },
    code: 'return triage({"text":"login fails","command":"triage"})',
    executionID: "exe_1",
    status: "completed",
    events: [{ type: "trace", kind: "return", value: "done" }],
    time: { created: 4, completed: 5 },
  },
  {
    id: "invocation-2",
    type: "invocation",
    trigger: { type: "event", name: "watch" },
    code: "return watch({})",
    executionID: "exe_2",
    status: "running",
    time: { created: 6 },
  },
]

test("renders each invocation as its own turn after the conversation", () => {
  const rows = Timeline.constructSessionMessageRows(messages, false, { type: "idle" }).rows
  expect(rows.map(TimelineRow.key)).toEqual([
    "user-message:user-1",
    "assistant-part:part:part:assistant-1:assistant-1:text:0",
    "turn-gap:invocation-1",
    "invocation:invocation-1",
    "turn-gap:invocation-2",
    "invocation:invocation-2",
  ])
})

test("renders displayed results as their own rows after the invocation that published them", () => {
  const rows = Timeline.constructSessionMessageRows(
    [
      ...messages.slice(0, 3),
      {
        id: "display-1",
        type: "display",
        blocks: [{ type: "markdown", text: "Found it" }],
        time: { created: 5 },
      },
    ],
    false,
    { type: "idle" },
  ).rows
  expect(rows.map(TimelineRow.key).slice(-3)).toEqual([
    "turn-gap:invocation-1",
    "invocation:invocation-1",
    "notice:display-1",
  ])
})
