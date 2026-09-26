import { expect, test } from "bun:test"
import { SessionSystemPrompt } from "@ocpp/core/session/system-prompt"

test("renders the default system prompt instructions", () => {
  const prompt = SessionSystemPrompt.make(["edit", "read", "shell"])
  expect(prompt).not.toContain("${OCPP_TOOL_GUIDANCE}")
  expect(prompt).toContain("Use `tools.edit` for targeted changes to existing text files")
  expect(prompt).toContain("Prefer `tools.read` over shell commands like `cat`.")
})
