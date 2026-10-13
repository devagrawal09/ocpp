function capabilityLoop(goal, base, maxSteps = 10) {
  let context = [{ goal }]
  let offered = []
  let trace = []
  const started = time.now()
  for (let step = 0; step < maxSteps; step += 1) {
    const current = [
      ...base,
      ...offered.filter(
        (capability, index, all) =>
          !base.some((selected) => selected.id === capability.id) &&
          all.findIndex((other) => other.id === capability.id) === index,
      ),
    ]
    const questions = Object.fromEntries(
      current.flatMap((capability, index) =>
        Object.entries(capability.questions).map(([key, question]) => [index + "." + key, question]),
      ),
    )
    const state = {
      context,
      capabilities: current.map((capability) => ({ id: capability.id, state: capability.state })),
    }
    const decision = Object.keys(questions).length ? tools.decision.ask({ state, questions }) : { answers: {} }
    const outcomes = current.map((capability, index) => {
      const answers = Object.fromEntries(
        Object.keys(capability.questions).map((key) => {
          const answer = decision.answers[index + "." + key]
          if (!answer) throw new Error("Missing judgment: " + index + "." + key)
          return [key, answer]
        }),
      )
      return { id: capability.id, outcome: capability.execute(answers, context) || {} }
    })
    context = outcomes.reduce((observations, entry) => {
      const replacement = entry.outcome.replaceContext
      const next = typeof replacement === "function" ? replacement(observations) : replacement || observations
      return entry.outcome.state === undefined ? next : [...next, { capability: entry.id, state: entry.outcome.state }]
    }, context)
    offered = outcomes.flatMap((entry) => entry.outcome.capabilities || [])
    trace = [
      ...trace,
      {
        step,
        capabilities: current.map((capability) => capability.id),
        decision,
        outcomes: outcomes.map((entry) => ({
          id: entry.id,
          state: entry.outcome.state,
          offered: (entry.outcome.capabilities || []).map((capability) => capability.id),
          exit: entry.outcome.exit === true,
        })),
      },
    ]
    if (outcomes.some((entry) => entry.outcome.exit))
      return { reason: "quit", context, trace, elapsedMs: time.now() - started }
  }
  return { reason: "step-limit", context, trace, elapsedMs: time.now() - started }
}

function capabilityQuit() {
  return {
    id: "quit",
    state: "Stopping is a judgment about the user's goal, not a test-status check.",
    questions: {
      done: {
        type: "noul",
        instructions:
          "The user's goal has been accomplished and no useful work remains. Judge the observations, including what changed and what was checked.",
      },
    },
    execute: (answers) => ({ state: { done: answers.done.noul }, exit: answers.done.noul >= 0.5 }),
  }
}

function capabilityCompact(keep = 8) {
  return {
    id: "compact",
    state: { keep },
    questions: {
      useful: {
        type: "noul",
        instructions:
          "Discarding older observations while retaining the goal and the newest observations would help this run. Prefer keeping evidence while the context is small.",
      },
    },
    execute: (answers) =>
      answers.useful.noul < 0.5
        ? {}
        : {
            replaceContext: (observations) => [observations[0], ...observations.slice(1).slice(-keep)],
          },
  }
}

function capabilityShell(workspace) {
  return {
    id: "shell",
    state: { command: "bun test", workspace },
    questions: {
      useful: {
        type: "noul",
        instructions:
          "Running bun test now would give useful new evidence toward the goal. Do not repeat an unchanged test run when a newer observation already records the same result; rerun after edits.",
      },
    },
    execute: (answers) =>
      answers.useful.noul < 0.5
        ? {}
        : {
            state: {
              command: "bun test",
              result: tools.shell({ command: "bun test", workdir: workspace, timeout: 20000 }),
            },
          },
  }
}

function capabilityEvaluate(request) {
  try {
    return tools.capability.evaluate(request)
  } catch (error) {
    return { ok: false, error: { message: String(error) } }
  }
}

function capabilityGenerated(source, environment, description) {
  return {
    id: description.id,
    state: description.state,
    questions: description.questions,
    execute: (answers, context) => {
      const result = capabilityEvaluate({
        code:
          source +
          "\nconst capability = createCapability(input.environment); return capability.execute(input.answers, input.context);",
        input: { environment, answers, context },
        tools: ["patch", "shell"],
      })
      const outcome = result.ok ? result.value || {} : { state: { error: result.error } }
      // Source is the durable boundary; the adapter re-offers itself, never native function objects.
      return { ...outcome, capabilities: result.ok ? [capabilityGenerated(source, environment, description)] : [] }
    },
  }
}

function capabilityFactory(workspace, model) {
  let generations = 0
  return {
    id: "factory",
    state: {
      purpose:
        "Read workspace files and observations, then use one LLM call to author an executable capability that can edit code with patch and run shell commands. Generation itself makes no workspace changes.",
      workspace,
      maxGenerations: 2,
      model,
    },
    questions: {
      useful: {
        type: "noul",
        instructions:
          "Authoring a new executable capability would enable progress toward the user's goal. Prefer using a capability already available if it can do the needed work; do not regenerate after success.",
      },
    },
    execute: (answers, context) => {
      if (answers.useful.noul < 0.5) return {}
      if (generations >= 2) return {}
      generations += 1
      const files = tools
        .glob({ pattern: "**/*.{ts,json,md}", path: workspace, limit: 20 })
        .filter((entry) => entry.type === "file")
        .map((entry) => ({ path: entry.path, content: tools.read({ path: entry.path, limit: 300 }).content }))
      const generated = tools.generate.code({
        language: "JavaScript",
        model,
        brief:
          "Author one capability that advances the user's goal using the observed workspace. Declare function createCapability(environment), returning { id, state, questions, execute(answers, context) }. Questions are a record of independent typed judgments. execute decides its own policy from their continuous values, performs actions, and returns { state? }. It may run tools.patch and tools.shell. Use absolute file paths in patches and environment.workspace as workdir. Never edit tests. Return no other top-level statements.",
        context: {
          goal: context[0].goal,
          workspace,
          files,
          observations: context,
          environment: { workspace, files },
          environmentContract:
            "createCapability receives only { workspace, files }. There is no environment.tools. Tools are the global tools.patch and tools.shell, exactly as the signatures below show. execute receives answers and the observation array.",
          example:
            "function createCapability(environment) { return { id: 'inspect-workspace', state: { workspace: environment.workspace }, questions: { inspect: { type: 'noul', instructions: 'Inspecting the working directory would help.' } }, execute: (answers, context) => answers.inspect.noul < 0.5 ? {} : { state: tools.shell({ command: 'pwd', workdir: environment.workspace }) } }; }",
          tools: {
            patch:
              "tools.patch({ patchText: string }) -> { applied, files }. Syntax: *** Begin Patch\n*** Update File: /absolute/path\n@@\n-old\n+new\n*** End Patch",
            shell:
              "tools.shell({ command: string, workdir: string, timeout?: number }) -> { exit, output, truncated, status }",
          },
          questions: {
            type: "noul",
            instructions: "Explain what this independent judgment asks; answers[key].noul is P(true).",
          },
        },
        constraints: [
          "No imports, exports, async, promises, eval, classes, regex, array/object mutation, or invented APIs. The global tools.patch and tools.shell paths are available; no ambient host APIs are available.",
          "Use ordinary function declarations, local let or const, immutable arrays and records, and exact static tools.patch/tools.shell calls.",
          "No tool calls while createCapability builds its state and questions. Put all effects in execute.",
          "Observe current files before applying a patch so re-offering the capability does not blindly apply the same edit again.",
          "Keep code small. Only access files inside the supplied scratch workspace.",
          "Only tools.patch may change files. Use tools.shell for observations and checks, never for writing files.",
        ],
      })
      const environment = { workspace, files }
      const described = capabilityEvaluate({
        code:
          generated.code +
          "\nconst capability = createCapability(input); return { id: capability.id, state: capability.state, questions: capability.questions };",
        input: environment,
        tools: ["patch", "shell"],
        maxToolCalls: 0,
      })
      if (!described.ok) return { state: { source: generated.code, error: described.error } }
      return {
        state: { source: generated.code, description: described.value },
        capabilities: [capabilityGenerated(generated.code, environment, described.value)],
      }
    },
  }
}

function capabilityDemo(input) {
  const workspace = input.text.trim()
  if (!workspace) throw new Error("Pass the absolute scratch workspace path.")
  return capabilityLoop(
    "Fix the failing tests without modifying the tests; preserve existing behavior and input immutability.",
    [
      capabilityQuit(),
      capabilityCompact(),
      capabilityShell(workspace),
      capabilityFactory(workspace, { providerID: "openai", id: "gpt-5.6-luna-fast" }),
    ],
    10,
  )
}

tools.command.define({
  name: "cap-demo",
  description: "Run the decision-first capability loop in a scratch workspace",
  handler: "capabilityDemo",
})
return { handler: "capabilityDemo", command: "/cap-demo <absolute-scratch-path>" }
