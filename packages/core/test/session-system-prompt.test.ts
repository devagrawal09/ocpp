import { expect, test } from "bun:test"
import { SessionSystemPrompt } from "@ocpp/core/session/system-prompt"

test("renders the default system prompt instructions", () => {
  const prompt = SessionSystemPrompt.make(["edit", "read", "shell"])
  expect(prompt).not.toContain("${OCPP_TOOL_GUIDANCE}")
  expect(prompt).toContain("# Tools\n- Your only tool is `execute`.")
  expect(prompt).toContain("Use `tools.edit` for targeted changes to existing text files")
  expect(prompt).toContain("Prefer `tools.read` over shell commands like `cat`.")
})

test("omits tool guidance when no tool is reachable", () => {
  const prompt = SessionSystemPrompt.make([])
  expect(prompt).not.toContain("${OCPP_TOOL_GUIDANCE}")
  expect(prompt).not.toContain("# Tools")
  expect(prompt).not.toContain("execute")
  expect(prompt).toContain("Read and follow them.\n\n# Communication")
})

test("explains commands and events only when their tools are reachable", () => {
  expect(SessionSystemPrompt.make(["read", "command.define", "event.define"])).toContain(
    "A saved function can also back a slash command the user runs (`tools.command.define`) or an event that runs on a schedule (`tools.event.define`).",
  )
  expect(SessionSystemPrompt.make(["read"])).not.toContain("tools.command.define")
})
