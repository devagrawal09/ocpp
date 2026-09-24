import { expect, test } from "bun:test"
import { toolInlineInfo } from "../../src/mini/tool"
import { canonicalToolPart } from "./fixture/tool-part"

test.each(["claude", "codex", "pi"])("renders %s with child-task presentation and provider identity", (name) => {
  const part = canonicalToolPart(name, {
    status: "running",
    input: { root: "/worktree", description: "Inspect changes" },
    metadata: { sessionID: "child", provider: name },
  })
  expect(toolInlineInfo(part)).toMatchObject({
    title: "Inspect changes",
    description: name[0].toUpperCase() + name.slice(1) + " Agent",
    icon: "•",
  })
})
