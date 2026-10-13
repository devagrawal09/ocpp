function capabilityTrial(input) {
  const workspace = input.text.trim()
  const result = capabilityDemo(input)
  const artifact = workspace + "/../trace-" + workspace.split("/").slice(-1)[0] + ".json"
  tools.patch({
    patchText:
      "*** Begin Patch\n*** Add File: " +
      artifact +
      "\n" +
      JSON.stringify(result, null, 2)
        .split("\n")
        .map((line) => "+" + line)
        .join("\n") +
      "\n*** End Patch",
  })
  return {
    workspace,
    artifact,
    reason: result.reason,
    elapsedMs: result.elapsedMs,
    steps: result.trace.length,
    generations: result.trace.flatMap((step) =>
      step.outcomes.filter((entry) => entry.id === "factory" && entry.state?.source),
    ).length,
  }
}

tools.command.define({
  name: "cap-trial",
  description: "Run the unchanged capability demo and save a per-workspace trace",
  handler: "capabilityTrial",
})
return { command: "/cap-trial <absolute-scratch-path>" }
