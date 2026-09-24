import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@ocpp/client/promise"
import { Timeline } from "./projection"

test.each(["claude", "codex", "pi"])("keeps %s in the child-task timeline while delegating", (name) => {
  const messages = [
    { id: "user", type: "user", text: "delegate", time: { created: 1 } },
    {
      id: "assistant",
      type: "assistant",
      agent: "build",
      model: { id: "model", providerID: "provider" },
      content: [
        {
          type: "tool",
          id: "call",
          name,
          state: { status: "running", input: { description: "Inspect" }, metadata: { sessionID: "child" } },
          time: { created: 2 },
        },
      ],
      time: { created: 2 },
    },
  ] satisfies SessionMessageInfo[]
  expect(Timeline.constructSessionMessageRows(messages, true, { type: "busy" }).rows.map((row) => row._tag)).toEqual([
    "UserMessage",
    "AssistantPart",
  ])
})
