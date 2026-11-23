function jevQuote(value) {
  return "'" + value.split("'").join("'\"'\"'") + "'"
}

function jevRead(path) {
  let page = tools.read({ path })
  let content = page.content
  while (page.truncated) {
    page = tools.read({ path, offset: page.next })
    content += "\n" + page.content
  }
  return content
}

function jevPreview(value, budget) {
  const serialized = JSON.stringify(value)
  if (serialized.length <= budget) return value
  let length = Math.max(0, Math.floor((budget - 100) / 2))
  let preview = {
    truncated: true,
    characters: serialized.length,
    head: serialized.slice(0, length),
    tail: length ? serialized.slice(-length) : "",
  }
  while (JSON.stringify(preview).length > budget && length > 0) {
    length = Math.floor(length / 2)
    preview = {
      truncated: true,
      characters: serialized.length,
      head: serialized.slice(0, length),
      tail: length ? serialized.slice(-length) : "",
    }
  }
  return preview
}

function jevJudgment(context, capabilities, questions) {
  // A conservative character ceiling leaves room for UTF-8 and the service's prompt overhead.
  const questionSize = JSON.stringify(questions).length
  if (questionSize > 4000)
    throw new Error(
      "Jev questions exceed the 4000-character judgment budget. Narrow capability questions before resuming; no questions were silently dropped.",
    )
  const budget = 8000 - questionSize
  const selected = [
    context[0],
    ...context
      .slice(1)
      .filter(
        (entry, index, all) =>
          !["repository", "library"].includes(entry.capability) ||
          !all.slice(index + 1).some((later) => later.capability === entry.capability),
      )
      .slice(-12),
  ]
  const share = Math.max(128, Math.floor((budget - 600) / (selected.length + capabilities.length)))
  return jevPreview(
    {
      notice:
        "Bounded judgment view, not complete evidence. Truncation is not evidence of absence or success. Full observations remain in the checkpoint and are passed unchanged to execute. Acquire narrower evidence when needed.",
      observations: context.length,
      context: selected.map((entry) =>
        entry.capability
          ? { capability: entry.capability, state: jevPreview(entry.state ?? null, share) }
          : jevPreview(entry, share),
      ),
      capabilities: capabilities.map((entry) => ({ id: entry.id, state: jevPreview(entry.state ?? null, share) })),
    },
    budget,
  )
}

function jevFile(path) {
  const exists = tools.shell({ command: "test -f " + jevQuote(path), workdir: "/", timeout: 20000 }).exit === 0
  let page = exists ? tools.read({ path }) : null
  let raw = page ? page.content : null
  while (page && page.truncated) {
    page = tools.read({ path, offset: page.next })
    raw += "\n" + page.content
  }
  const envelope = raw === null ? null : JSON.parse(raw)
  if (raw !== null && (!envelope || envelope.version !== 1 || !Array.isArray(envelope.chunks)))
    throw new Error("Unsupported Jev checkpoint")
  return {
    value: envelope ? JSON.parse(envelope.chunks.join("")) : null,
    save: (value) => {
      const serialized = JSON.stringify(value)
      const content = JSON.stringify(
        {
          version: 1,
          chunks: Array.from({ length: Math.ceil(serialized.length / 200) }, (_, index) =>
            serialized.slice(index * 200, (index + 1) * 200),
          ),
        },
        null,
        2,
      )
      tools.patch({
        patchText:
          "*** Begin Patch\n" +
          (raw === null
            ? "*** Add File: " + path + "\n"
            : "*** Update File: " +
              path +
              "\n@@\n" +
              raw
                .trimEnd()
                .split("\n")
                .map((line) => "-" + line)
                .join("\n") +
              "\n") +
          content
            .split("\n")
            .map((line) => "+" + line)
            .join("\n") +
          "\n*** End Patch",
      })
      raw = content + "\n"
    },
  }
}

function jevProject(workspace, goal) {
  const listing = tools.shell({
    command:
      "git ls-files --cached --others --exclude-standard -- AGENTS.md README.md ROADMAP.md package.json '**/package.json' '**/AGENTS.md'",
    workdir: workspace,
    timeout: 20000,
  })
  if (listing.exit !== 0) throw new Error("/jev requires a Git repository: " + listing.output)
  const paths = listing.output.split("\n").filter((path) => path && !path.startsWith("../"))
  const status = tools.shell({ command: "git status --short", workdir: workspace, timeout: 20000 })
  const words = goal
    .toLowerCase()
    .split(" ")
    .map((word) => word.trim())
    .filter((word) => word.length > 3)
  const packages = paths.filter(
    (path) =>
      path.endsWith("/package.json") &&
      (words.some((word) => path.toLowerCase().includes(word)) || status.output.includes(path.slice(0, -12))),
  )
  const parents = workspace
    .split("/")
    .slice(1)
    .map(
      (_, index) =>
        "/" +
        workspace
          .split("/")
          .slice(1, index + 2)
          .join("/"),
    )
  const instructionPaths = [
    ...parents.map((directory) => directory + "/AGENTS.md"),
    ...paths
      .filter((path) => path.endsWith("/AGENTS.md") && packages.some((pkg) => pkg.startsWith(path.slice(0, -9))))
      .map((path) => workspace + "/" + path),
  ].filter((path, index, all) => all.indexOf(path) === index)
  const ambient = parents
    .filter(
      (directory) =>
        tools.shell({
          command: "test -f " + jevQuote(directory + "/AGENTS.md"),
          workdir: workspace,
          timeout: 20000,
        }).exit === 0,
    )
    .map((directory) => ({ path: directory + "/AGENTS.md" }))
  const selected = ["package.json", "README.md", "ROADMAP.md", ...packages].filter((path) => paths.includes(path))
  const instructions = instructionPaths
    .filter((path) => ambient.some((entry) => entry.path === path) || paths.includes(path.slice(workspace.length + 1)))
    .map((path) => ({ path, content: jevRead(path) }))
  return {
    workspace,
    listing,
    status,
    instructions,
    files: selected.map((path) => ({ path: workspace + "/" + path, content: jevRead(workspace + "/" + path) })),
  }
}

function jevDiscover(workspace) {
  return {
    id: "repository-search",
    state:
      "Search tracked source using significant words from the current goal. Generated capabilities can perform narrower searches and read relevant files.",
    questions: {
      useful: {
        type: "noul",
        instructions:
          "A first source search for this goal would provide useful evidence. Do not repeat the same goal search without a new reason.",
      },
    },
    execute: (answers, context) => {
      const goal = context[0].goal
      if (answers.useful.noul < 0.5 || context.some((entry) => entry.state?.searchedGoal === goal)) return {}
      const words = goal
        .split(" ")
        .filter((word) => word.length > 3)
        .slice(0, 6)
      if (!words.length) return {}
      return {
        state: {
          searchedGoal: goal,
          result: tools.shell({
            command: "git --no-pager grep -n -I -F " + words.map((word) => "-e " + jevQuote(word)).join(" ") + " -- .",
            workdir: workspace,
            timeout: 20000,
          }),
        },
      }
    },
  }
}

function jevChecks(project) {
  const candidates = project.files
    .filter((file) => file.path.endsWith("/package.json"))
    .flatMap((file) => {
      const pkg = JSON.parse(file.content)
      return ["typecheck", "test:unit", "test", "lint"]
        .filter((name) => pkg.scripts?.[name] && !pkg.scripts[name].includes("do-not-run-tests-from-root"))
        .map((name) => ({
          command: "bun run " + name,
          workdir: file.path.slice(0, -13),
        }))
    })
  if (!candidates.length)
    return {
      id: "project-checks",
      state:
        "No suitable package checks discovered. Inspect project instructions and acquire a capability to run the correct checks.",
      questions: {},
      execute: () => ({}),
    }
  return {
    id: "project-checks",
    state: { candidates },
    questions: {
      useful: {
        type: "noul",
        instructions:
          "Running a discovered project check now would provide useful new evidence required by the goal. An informational repository overview does not need tests or lint merely because scripts exist. Avoid repeating unchanged checks; choose a relevant package, not a broad root suite.",
      },
      selected: {
        type: "choice",
        instructions: "Which discovered check is most relevant to the current changes and goal?",
        criteria: Object.fromEntries(candidates.map((candidate, index) => [String(index), candidate])),
      },
    },
    execute: (answers) =>
      answers.useful.noul < 0.5
        ? {}
        : {
            state: {
              check: candidates[Number(answers.selected.choice)],
              result: tools.shell({
                ...candidates[Number(answers.selected.choice)],
                timeout: 30000,
              }),
            },
          },
  }
}

function jevReport(task, path) {
  return {
    status: task.status,
    task: path,
    goal: task.goal,
    workspace: task.workspace,
    steps: task.trace.length,
    generations: task.generations,
    generationBudget: task.maxGenerations,
    pending: task.pending,
    changes: task.review
      ? {
          ...task.review,
          diff: {
            ...task.review.diff,
            output: task.review.diff.output.slice(0, 16000),
            truncated: task.review.diff.truncated || task.review.diff.output.length > 16000,
          },
        }
      : null,
    recent: task.context.slice(-6).map((entry) => {
      const text = JSON.stringify(entry.state) || ""
      return text.length > 2000 ? { ...entry, state: { preview: text.slice(0, 2000), truncated: true } } : entry
    }),
    next:
      task.status === "quit"
        ? "Review the diff and checks. Jev judged the task finished; this is not an independent correctness verdict."
        : "Use /jev resume, /jev <correction>, or hand this checkpoint and worktree to an ordinary agent. An interrupted action may already have had effects; inspect before repeating it.",
  }
}

function jevRun(input, settings) {
  const text = input.text.trim()
  const options = text.startsWith("{") ? JSON.parse(text) : {}
  const action =
    options.action || (text === "status" || text === "resume" ? text : text.startsWith("new ") ? "new" : "work")
  const goal = options.goal || (action === "new" ? text.slice(4).trim() : action === "work" ? text : "")
  const taskPath = settings.stateDirectory + "/tasks/" + settings.taskID + ".json"
  const file = jevFile(taskPath)
  let task = file.value
  if (action === "status")
    return task ? jevReport(task, taskPath) : { status: "empty", next: "Use /jev <goal> to start a task." }
  if (!task && !goal) throw new Error("Use /jev <goal> to start, then /jev resume or /jev <correction>.")
  const workspace = options.workspace || (action === "new" ? settings.workspace : task?.workspace) || settings.workspace
  const steps = options.maxSteps === undefined ? 3 : options.maxSteps
  if (!Number.isInteger(steps) || steps < 1 || steps > 20) throw new Error("maxSteps must be an integer from 1 to 20")
  const budget =
    options.maxGenerations === undefined
      ? task?.maxGenerations === undefined
        ? 6
        : task.maxGenerations
      : options.maxGenerations
  if (!Number.isInteger(budget) || budget < 0 || budget > 20)
    throw new Error("maxGenerations must be an integer from 0 to 20")
  if (task && action !== "new" && workspace !== task.workspace) throw new Error("Start a new task to change workspace")
  if (!task || action === "new") {
    if (!goal) throw new Error("A new task needs a goal")
    if (task) jevFile(settings.stateDirectory + "/tasks/" + settings.taskID + "-" + task.started + ".json").save(task)
    const baseline = tools.shell({ command: "git diff --no-ext-diff --no-color", workdir: workspace, timeout: 20000 })
    task = {
      version: 1,
      workspace,
      goal,
      started: time.now(),
      status: "ready",
      context: [{ goal }],
      trace: [],
      generations: 0,
      model: options.model || settings.model,
      maxGenerations: budget,
      retired: [],
      pending: null,
      batchCompleted: [],
      baseline,
      review: null,
    }
    file.save(task)
  }
  if (task.version !== 1 || !Array.isArray(task.context) || !Array.isArray(task.trace))
    throw new Error("Invalid Jev task checkpoint")
  if (task.pending)
    task = {
      ...task,
      context: [
        ...task.context,
        {
          capability: "recovery",
          state: {
            interrupted: task.pending,
            instructions:
              "An earlier action did not checkpoint its outcome. It may already have changed files. Inspect the current worktree before retrying; do not assume it rolled back.",
          },
        },
      ],
    }
  const completed = goal && goal !== task.goal ? [] : task.batchCompleted || []
  if (goal && goal !== task.goal)
    task = {
      ...task,
      goal,
      context: [{ goal }, ...task.context.slice(1), { capability: "user", state: { correction: goal } }],
    }
  task = {
    ...task,
    maxGenerations: budget,
    model: options.model || task.model || settings.model,
    status: "running",
    pending: null,
  }
  file.save(task)
  const project = jevProject(workspace, task.goal)
  const previousProject = task.context.filter((entry) => entry.capability === "repository").slice(-1)[0]
  if (JSON.stringify(previousProject?.state) !== JSON.stringify(project))
    task = { ...task, context: [...task.context, { capability: "repository", state: project }] }
  file.save(task)
  const library = capabilityLibrary(settings.stateDirectory + "/library.json")
  const environment = { workspace, files: project.files }
  const loaded = library
    .active()
    .filter((entry) => !task.retired.includes(entry.ref))
    .map((entry) => {
      const description = capabilityLibraryDescribe(library.snapshot(), entry.ref, environment)
      return description.ok
        ? { ref: entry.ref, capability: capabilityLibraryGenerated(library, entry.ref, environment, description.value) }
        : { ref: entry.ref, error: description.error }
    })
  task = {
    ...task,
    context: [
      ...task.context,
      {
        capability: "library",
        state: {
          available: library.active().map((entry) => ({ ref: entry.ref, description: entry.description })),
          errors: loaded.filter((entry) => entry.error),
        },
      },
    ],
  }
  file.save(task)
  const factory = capabilityLibraryFactory(
    library,
    environment,
    task.model,
    loaded
      .filter(
        (entry) =>
          entry.capability && !task.context.some((observation) => observation.capability === entry.capability.id),
      )
      .map((entry) => entry.ref),
    {
      maxGenerations: Math.max(0, budget - task.generations),
      files: project.files,
      instructions: project.instructions,
      project: { listing: project.listing, status: project.status },
      workspaceRules:
        "Only access this repository and the task's explicit external inputs. Preserve unrelated work. Informational goals require a read-only explanation, not source edits or broad test runs. Return the explanation as an observation and show it with tools.display_result. Never reset, stage, commit, push, or install dependencies unless the user asks. Tests may be added or changed when the goal requires it, never weakened to manufacture success. Only tools.patch writes files; shell is for observations and checks. Read applicable AGENTS.md before editing. Use package-appropriate checks, never assume bun test at repository root is valid. Each evaluator call permits at most 16 tool calls and 60 seconds. Keep work incremental.",
      onGeneration: () => {
        task = { ...task, generations: task.generations + 1 }
        file.save(task)
      },
    },
  )
  const base = [capabilityQuit(), capabilityCompact(16), jevDiscover(workspace), jevChecks(project), factory]
  let offered = loaded.filter((entry) => entry.capability).map((entry) => entry.capability)
  for (let step = 0; step < steps; step += 1) {
    const prior = task.context
    const current = [
      ...base,
      ...offered.filter(
        (capability, index, all) =>
          !base.some((entry) => entry.id === capability.id) &&
          all.findIndex((entry) => entry.id === capability.id) === index,
      ),
    ].filter((capability) => step > 0 || !completed.includes(capability.id))
    const questions = Object.fromEntries(
      current.flatMap((capability, index) =>
        Object.entries(capability.questions).map(([key, question]) => [index + "." + key, question]),
      ),
    )
    const judgment = Object.keys(questions).length ? jevJudgment(prior, current, questions) : null
    task = {
      ...task,
      pending: { phase: "judgment", step: task.trace.length },
      batchCompleted: step === 0 ? completed : [],
      status: "running",
    }
    file.save(task)
    const decision = Object.keys(questions).length
      ? tools.decision.ask({
          state: judgment,
          questions,
        })
      : { answers: {} }
    let observations = prior
    let outcomes = []
    let next = []
    for (let index = 0; index < current.length; index += 1) {
      const capability = current[index]
      const answers = Object.fromEntries(
        Object.keys(capability.questions).map((key) => {
          const answer = decision.answers[index + "." + key]
          if (!answer) throw new Error("Missing judgment: " + index + "." + key)
          return [key, answer]
        }),
      )
      task = { ...task, pending: { phase: "execute", capability: capability.id, step: task.trace.length } }
      file.save(task)
      const outcome = capability.execute(answers, prior) || {}
      const replacement = outcome.replaceContext
      observations = typeof replacement === "function" ? replacement(observations) : replacement || observations
      if (outcome.state !== undefined)
        observations = [...observations, { capability: capability.id, state: outcome.state }]
      next = [...next, ...(outcome.capabilities || [])]
      outcomes = [
        ...outcomes,
        {
          id: capability.id,
          state: outcome.state,
          offered: (outcome.capabilities || []).map((entry) => entry.id),
          exit: outcome.exit === true,
        },
      ]
      const ref = capability.id.startsWith("library:") ? capability.id.slice(8) : null
      task = {
        ...task,
        context: observations,
        pending: null,
        batchCompleted: [...task.batchCompleted, capability.id],
        retired:
          ref && !(outcome.capabilities || []).some((entry) => entry.id === capability.id)
            ? [...task.retired, ref]
            : task.retired,
      }
      file.save(task)
    }
    offered = next
    task = {
      ...task,
      trace: [...task.trace, { step: task.trace.length, decision, outcomes }],
      batchCompleted: [],
      status: outcomes.some((outcome) => outcome.exit) ? "quit" : "paused",
    }
    file.save(task)
    tools.display_result({
      title: "Jev Step " + task.trace.length,
      blocks: [
        {
          type: "markdown",
          text:
            "Status: **" +
            task.status +
            "**. Generations: " +
            task.generations +
            "/" +
            budget +
            ".\n\n" +
            outcomes
              .filter((outcome) => outcome.state !== undefined)
              .map((outcome) => "- " + outcome.id + ": \u0060" + JSON.stringify(outcome.state).slice(0, 400) + "\u0060")
              .join("\n"),
        },
      ],
    })
    if (task.status === "quit") break
  }
  task = {
    ...task,
    review: {
      status: tools.shell({ command: "git status --short", workdir: workspace, timeout: 20000 }),
      diff: tools.shell({ command: "git diff --no-ext-diff --no-color", workdir: workspace, timeout: 20000 }),
      whitespace: tools.shell({ command: "git diff --check", workdir: workspace, timeout: 20000 }),
      attribution:
        "Full worktree diff, not only Jev edits. The initial diff is retained in the checkpoint as baseline. Untracked files appear in status, not git diff.",
    },
    pending: null,
  }
  file.save(task)
  const report = jevReport(task, taskPath)
  tools.display_result({
    title: "Jev Handoff",
    blocks: [
      {
        type: "markdown",
        text:
          "**" +
          report.status +
          "**: " +
          task.goal +
          "\n\n" +
          report.next +
          "\n\nCheckpoint: " +
          taskPath +
          "\n\n" +
          task.review.attribution,
      },
      { type: "code", language: "diff", text: task.review.diff.output || "No tracked diff." },
    ],
  })
  return report
}
