const jevDailyRoot = tools.shell({ command: "pwd", timeout: 20000 }).output.trim()
const jevDailySettings = {
  workspace: jevDailyRoot,
  sourceDirectory: jevDailyRoot + "/.ocpp/experiments/decision-loop",
  stateDirectory: tools.shell({ command: 'printf "%s" "$HOME/.local/share/ocpp/jev"', timeout: 20000 }).output.trim(),
  taskID: "task-" + time.now(),
}

function jevDailyCommand(input) {
  if (
    !tools
      .search({ namespace: "capability", limit: 100 })
      .items.some((entry) => entry.path === "tools.capability.evaluate")
  ) {
    const error =
      "capability.evaluate is unavailable on the server handling this command. Check the capability plugin status on that same server. If it predates ctx.tool.evaluator, restart that server or reconnect the UI to an up-to-date server. No Jev task was started or changed."
    tools.display_result({
      title: "Jev Requires the Confined Evaluator",
      blocks: [{ type: "markdown", text: error }],
    })
    return { status: "unavailable", error }
  }
  const source = ["notebook", "library", "jev"]
    .map((name) => {
      const path = jevDailySettings.sourceDirectory + "/" + name + ".js"
      let page = tools.read({ path })
      let content = page.content
      while (page.truncated) {
        page = tools.read({ path, offset: page.next })
        content += "\n" + page.content
      }
      return content.split("\ntools.command.define(")[0]
    })
    .join("\n")
  const result = tools.capability.evaluate({
    code: "{\n" + source + "\nreturn jevRun(input.command, input.settings);\n}",
    input: { command: input, settings: jevDailySettings },
    tools: ["capability.evaluate", "decision.ask", "generate.code", "glob", "read", "patch", "shell", "display_result"],
    maxToolCalls: 100,
    timeoutMs: 120000,
  })
  if (result.ok) return result.value
  tools.display_result({
    title: "Jev Paused With Diagnostic",
    blocks: [
      {
        type: "markdown",
        text:
          "The run stopped before returning a handoff. File effects may already exist; completed action checkpoints are retained. Use /jev status, then /jev resume or a correction.\n\n" +
          JSON.stringify(result.error),
      },
    ],
  })
  return result
}

tools.command.define({
  name: "jev",
  description: "Jev-first repository work. Pass a goal, resume, status, new <goal>, or JSON options.",
  handler: "jevDailyCommand",
})
return {
  command: "/jev <goal>",
  workspace: jevDailySettings.workspace,
  stateDirectory: jevDailySettings.stateDirectory,
}
