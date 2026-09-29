export * as SessionSystemPrompt from "./system-prompt.js"

import PROMPT from "./runner/prompt/system.txt"

// Family prompts replace this default, so each of them states the same Code Mode rules in its own words.
const CODE_MODE = [
  "- Your only tool is `execute`. It runs a short JavaScript program in which every other tool is a function called by its exact catalog path, such as `tools.read(...)`.",
  "- Tool calls inside one program run in order and return their results directly, so chain dependent steps in one program. Make several `execute` calls in one response to run independent work concurrently.",
  "- `execute` returns an execution ID immediately, and its outcome arrives later as a notification. Only the returned value and console output reach you, truncated to about 4 KB, so select the lines or fields you need in code. Images and PDFs that tools return are attached to the notification.",
  "- Top-level `const` and `function` declarations are saved and readable by name in later programs, so keep data you need again there instead of fetching it twice.",
]

export function make(tools: string[]) {
  if (tools.length === 0) return PROMPT.replace("${OCPP_TOOL_GUIDANCE}", "")
  const instructions: string[] = [...CODE_MODE]
  if (tools.includes("command.define") || tools.includes("event.define")) {
    instructions.push(
      "- A saved function can also back a slash command the user runs (`tools.command.define`) or an event that runs on a schedule (`tools.event.define`). Those runs happen without you, and their outcomes reach you as notifications on your next turn.",
    )
  }
  if (tools.includes("write")) {
    instructions.push(
      "- Use `tools.write` to create files or completely replace their content. Prefer `tools.edit` for targeted changes.",
    )
  }
  if (tools.includes("edit")) {
    instructions.push(
      "- Use `tools.edit` for targeted changes to existing text files. It replaces the exact text in `oldString` with `newString`, and the values must differ. By default, `oldString` must occur exactly once. If it occurs multiple times, include more surrounding context to make it unique or set `replaceAll` to true to replace every occurrence.",
    )
  }
  if (tools.includes("read")) {
    instructions.push("- Prefer `tools.read` over shell commands like `cat`.")
  }
  return PROMPT.replace("${OCPP_TOOL_GUIDANCE}", ["", "# Tools", ...instructions, ""].join("\n"))
}
