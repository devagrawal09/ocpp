function capabilityLibraryProgram(entries, ref) {
  const needed = entries.reduceRight(
    (refs, entry) => (refs.includes(entry.ref) ? [...refs, ...entry.dependencies] : refs),
    [ref],
  )
  return (
    entries
      .filter((entry) => needed.includes(entry.ref))
      .map(
        (entry) =>
          "const c" +
          entries.findIndex((item) => item.ref === entry.ref) +
          " = (function() {\n" +
          entry.source +
          "\nreturn createCapability(input.environment, {" +
          entry.dependencies
            .map(
              (dependency) => JSON.stringify(dependency) + ": c" + entries.findIndex((item) => item.ref === dependency),
            )
            .join(",") +
          "});\n})();",
      )
      .join("\n") +
    "\nconst capability = c" +
    entries.findIndex((entry) => entry.ref === ref) +
    ";\n"
  )
}

function capabilityLibraryManifest(manifest, entries) {
  if (!manifest || typeof manifest.id !== "string" || !manifest.id.trim() || manifest.id.includes("@"))
    return "manifest.id must be a nonempty string without @"
  if (typeof manifest.description !== "string" || !manifest.description.trim())
    return "manifest.description must explain applicability"
  if (
    ![manifest.dependencies, manifest.supersedes].every(
      (refs) =>
        Array.isArray(refs) &&
        refs.every(
          (ref, index) =>
            typeof ref === "string" && refs.indexOf(ref) === index && entries.some((entry) => entry.ref === ref),
        ),
    )
  )
    return "dependencies and supersedes must be unique existing revision references"
  return null
}

function capabilityLibrary(path) {
  if (!path || !path.startsWith("/")) throw new Error("Library path must be absolute")
  const exists =
    tools.glob({
      path: path.split("/").slice(0, -1).join("/") || "/",
      pattern: path.split("/").slice(-1)[0],
      limit: 1,
    }).length > 0
  let page = exists ? tools.read({ path }) : null
  let raw = page ? page.content : null
  while (page && page.truncated) {
    page = tools.read({ path, offset: page.next })
    raw += "\n" + page.content
  }
  const envelope = raw === null ? null : JSON.parse(raw)
  if (
    raw !== null &&
    (!envelope ||
      envelope.version !== 1 ||
      !Array.isArray(envelope.chunks) ||
      !envelope.chunks.every((chunk) => typeof chunk === "string"))
  )
    throw new Error("Unsupported capability library")
  let stored = envelope === null ? { version: 1, entries: [] } : JSON.parse(envelope.chunks.join(""))
  if (stored.version !== 1 || !Array.isArray(stored.entries)) throw new Error("Unsupported capability library")
  stored.entries.forEach((entry, index) => {
    const previous = stored.entries.slice(0, index)
    const revision = previous.filter((item) => item.id === entry.id).length + 1
    const error = capabilityLibraryManifest(entry, previous)
    if (
      error ||
      entry.revision !== revision ||
      entry.ref !== entry.id + "@" + revision ||
      typeof entry.source !== "string" ||
      !Array.isArray(entry.evidence)
    )
      throw new Error(
        "Invalid capability library entry: " +
          (entry.ref || index) +
          " " +
          (error || "invalid revision/source/evidence"),
      )
  })
  const save = (next) => {
    // Bounded JSON string chunks avoid the read tool's per-line truncation.
    const serialized = JSON.stringify(next)
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
    stored = next
    raw = content + "\n"
  }
  return {
    snapshot: () => stored.entries,
    active: () =>
      stored.entries.filter((entry) => !stored.entries.some((other) => other.supersedes.includes(entry.ref))),
    admit: (source, environment) => {
      const metadata = capabilityEvaluate({
        code: source + "\nreturn manifest;",
        maxToolCalls: 0,
        tools: ["patch", "shell"],
      })
      if (!metadata.ok) return metadata
      const error = capabilityLibraryManifest(metadata.value, stored.entries)
      if (error) return { ok: false, error: { message: error } }
      const revision = stored.entries.filter((entry) => entry.id === metadata.value.id).length + 1
      const entry = {
        id: metadata.value.id,
        revision,
        ref: metadata.value.id + "@" + revision,
        description: metadata.value.description,
        dependencies: metadata.value.dependencies,
        supersedes: metadata.value.supersedes,
        source,
        evidence: [],
      }
      const entries = [...stored.entries, entry]
      const described = capabilityLibraryDescribe(entries, entry.ref, environment)
      if (!described.ok) return described
      save({ version: 1, entries })
      return { ok: true, entry, description: described.value }
    },
    record: (ref, evidence) =>
      save({
        version: 1,
        entries: stored.entries.map((entry) =>
          entry.ref === ref ? { ...entry, evidence: [...entry.evidence, evidence] } : entry,
        ),
      }),
  }
}

function capabilityLibraryDescribe(entries, ref, environment) {
  const result = capabilityEvaluate({
    code:
      capabilityLibraryProgram(entries, ref) +
      "return { id: capability.id, state: capability.state, questions: capability.questions, executable: typeof capability.execute === 'function' };",
    input: { environment },
    tools: ["patch", "shell"],
    maxToolCalls: 0,
  })
  if (!result.ok) return result
  const entry = entries.find((item) => item.ref === ref)
  const value = result.value
  if (
    !value ||
    value.id !== entry.id ||
    !value.executable ||
    !value.questions ||
    Array.isArray(value.questions) ||
    typeof value.questions !== "object" ||
    !Object.values(value.questions).every(
      (question) =>
        question &&
        typeof question.instructions === "string" &&
        ((question.type === "noul" &&
          (question.criteria === undefined ||
            question.criteria === null ||
            (typeof question.criteria === "object" && !Array.isArray(question.criteria)))) ||
          (question.type === "choice" &&
            question.criteria &&
            typeof question.criteria === "object" &&
            !Array.isArray(question.criteria) &&
            Object.keys(question.criteria).length > 0) ||
          (question.type === "score" &&
            Array.isArray(question.criteria) &&
            question.criteria.length >= 2 &&
            question.criteria.length <= 10)),
    )
  )
    return { ok: false, error: { message: "Expected matching id, independent typed questions, and execute function" } }
  return result
}

function capabilityLibraryGenerated(library, ref, environment, description) {
  return {
    id: "library:" + ref,
    state: {
      revision: ref,
      description: library.snapshot().find((entry) => entry.ref === ref).description,
      value: description.state,
    },
    questions: description.questions,
    execute: (answers, context) => {
      // Supersession changes future offerings, not the frozen prior-context batch.
      const evaluated = capabilityEvaluate({
        code:
          capabilityLibraryProgram(library.snapshot(), ref) +
          "return capability.execute(input.answers, input.context);",
        input: { environment, answers, context },
        tools: ["patch", "shell"],
      })
      const value = evaluated.ok ? evaluated.value : null
      const result =
        evaluated.ok &&
        value !== null &&
        (typeof value !== "object" ||
          Array.isArray(value) ||
          (value.exit !== undefined && typeof value.exit !== "boolean") ||
          (value.replaceContext !== undefined && !Array.isArray(value.replaceContext)))
          ? {
              ok: false,
              error: { message: "Expected an outcome record with optional boolean exit and array replaceContext" },
              toolCalls: evaluated.toolCalls,
            }
          : evaluated
      const outcome = result.ok ? result.value || {} : {}
      const evidence = { workspace: environment.workspace, goal: context[0].goal, answers, result }
      library.record(ref, evidence)
      return {
        ...outcome,
        state: outcome.state === undefined ? { library: { ref, ...evidence } } : outcome.state,
        capabilities:
          result.ok && library.active().some((entry) => entry.ref === ref)
            ? [capabilityLibraryGenerated(library, ref, environment, description)]
            : [],
      }
    },
  }
}

function capabilityLibraryFactory(library, environment, model, initial = [], options = {}) {
  let generations = 0
  let pending = initial
  return {
    id: "factory",
    state: {
      purpose: "Acquire, compose, or generalize reusable capabilities only when the repertoire is insufficient",
      maxGenerations: options.maxGenerations === undefined ? 2 : options.maxGenerations,
      library: library.active().map((entry) => ({ ref: entry.ref, description: entry.description })),
    },
    questions: {
      useful: {
        type: "noul",
        instructions:
          "New or improved executable behavior is needed for the goal. Prefer existing library capabilities when applicable. Wait for execution evidence from newly acquired behavior before proposing another. Do not regenerate after success.",
      },
    },
    execute: (answers, context) => {
      pending = pending.filter(
        (ref) =>
          !context.some(
            (observation) => observation.capability === "library:" + ref || observation.state?.library?.ref === ref,
          ),
      )
      if (
        answers.useful.noul < 0.5 ||
        generations >= (options.maxGenerations === undefined ? 2 : options.maxGenerations) ||
        pending.length
      )
        return {}
      generations += 1
      if (options.onGeneration) options.onGeneration()
      const files =
        options.files ||
        tools
          .glob({ pattern: "**/*.{ts,json,md}", path: environment.workspace, limit: 20 })
          .filter((entry) => entry.type === "file")
          .map((entry) => ({ path: entry.path, content: tools.read({ path: entry.path, limit: 300 }).content }))
      const generated = tools.generate.code({
        language: "JavaScript",
        model,
        brief:
          "Author reusable behavior for the current goal. Add missing behavior, compose existing capabilities, or generalize narrow ones. Declare const manifest = { id, description, dependencies: [], supersedes: [] } and function createCapability(environment, library), returning { id: manifest.id, state, questions, execute(answers, context) }. Use exact revision references from the supplied library. library[ref] is the instantiated dependency capability; you may reuse its questions and call its execute with the appropriate answers and context. Only declared dependencies are supplied. Supersedes selects existing revisions to retire from future offerings, without deleting them. Return only these declarations.",
        context: {
          goal: context[0].goal,
          observations: context,
          environment: { workspace: environment.workspace, files },
          library: library.snapshot(),
          active: library.active().map((entry) => entry.ref),
          instructions: options.instructions || [],
          project: options.project || null,
          example:
            "const manifest = { id: 'inspect-current-files', description: 'Inspect files before a focused edit', dependencies: [], supersedes: [] }; function createCapability(environment, library) { return { id: manifest.id, state: { workspace: environment.workspace }, questions: { useful: { type: 'noul', instructions: 'Inspecting the current files would provide new useful evidence.' } }, execute: (answers, context) => answers.useful.noul < 0.5 ? {} : { state: tools.shell({ command: 'git status --short', workdir: environment.workspace, timeout: 20000 }) } }; }",
          contract:
            "questions is an object keyed by question name, never an array. execute receives answers[key].noul, a number from 0 to 1. Outcome exit is optional boolean, never a shell exit code. Shell timeout is milliseconds.",
          tools: {
            patch:
              "tools.patch({ patchText: string }); *** Begin Patch\n*** Update File: /absolute/path\n@@\n-old\n+new\n*** End Patch",
            shell:
              "tools.shell({ command: string, workdir: string, timeout?: number }) returns { exit, output, truncated, status }. timeout is milliseconds; use 20000 or 30000, not 20 or 30.",
          },
        },
        constraints: [
          "No imports, exports, async, promises, eval, classes, regex, mutation, or invented APIs. Use immutable data and ordinary functions.",
          "Environment is only { workspace, files }. No environment.tools. Only exact global tools.patch and tools.shell paths are available.",
          "No effects while declaring manifest or constructing capabilities, including dependencies. All effects belong in execute.",
          "Questions are independent typed judgments: { type: 'noul', instructions: string }, answers[key].noul is P(true). Capabilities decide their own execution policy.",
          "Generated outcomes are JSON data: { state?, exit?, replaceContext?: array }. Do not return functions or capabilities across the evaluator boundary.",
          "Prefer reusable operations over hardcoded task patches. Resolve paths and content from the current environment or fresh observations, not a previous workspace. Observe before editing; do not blindly repeat edits.",
          options.workspaceRules ||
            "Only access the supplied scratch workspace. Never edit tests. Only patch may write; shell is for observations and checks.",
          "Inspect current files and applicable AGENTS.md before editing. Use small context patches rather than whole-file equality guards. Report actual checks, failures, and unresolved work in state.",
          "Do not set exit from a check result. The separate quit capability owns the completion judgment.",
        ],
      })
      const admitted = library.admit(generated.code, { workspace: environment.workspace, files })
      if (!admitted.ok) return { state: { source: generated.code, error: admitted.error } }
      pending = [admitted.entry.ref]
      return {
        state: { source: generated.code, admitted: admitted.entry.ref, description: admitted.description },
        capabilities: [
          capabilityLibraryGenerated(
            library,
            admitted.entry.ref,
            { workspace: environment.workspace, files },
            admitted.description,
          ),
        ],
      }
    },
  }
}

function capabilityLibraryRun(input) {
  if (!input.workspace || !input.workspace.startsWith("/")) throw new Error("Pass an absolute scratch workspace")
  const library = capabilityLibrary(input.library)
  const environment = {
    workspace: input.workspace,
    files: tools
      .glob({
        pattern: "**/*.{ts,json,md}",
        path: input.workspace,
        limit: 20,
      })
      .filter((entry) => entry.type === "file")
      .map((entry) => ({ path: entry.path, content: tools.read({ path: entry.path, limit: 300 }).content })),
  }
  const loaded = library.active().map((entry) => {
    const description = capabilityLibraryDescribe(library.snapshot(), entry.ref, environment)
    return description.ok
      ? { ref: entry.ref, capability: capabilityLibraryGenerated(library, entry.ref, environment, description.value) }
      : { ref: entry.ref, error: description.error }
  })
  // Offer the initial repertoire once, then let adapters own their lifecycle.
  let first = true
  const initial = {
    id: "library",
    state: {
      available: library.active().map((entry) => ({ ref: entry.ref, description: entry.description })),
      errors: loaded.filter((entry) => entry.error),
    },
    questions: {},
    execute: () => {
      if (!first) return {}
      first = false
      return {
        state: { libraryLoading: loaded.map((entry) => ({ ref: entry.ref, error: entry.error })) },
        capabilities: loaded.filter((entry) => entry.capability).map((entry) => entry.capability),
      }
    },
  }
  const result = capabilityLoop(
    input.goal || "Fix the failing tests without modifying tests; preserve existing behavior and input immutability.",
    [
      capabilityQuit(),
      capabilityCompact(),
      capabilityShell(input.workspace),
      initial,
      capabilityLibraryFactory(
        library,
        environment,
        input.model || { providerID: "openai", id: "gpt-5.6-luna-fast" },
        loaded.filter((entry) => entry.capability).map((entry) => entry.ref),
      ),
    ],
    input.maxSteps === undefined ? 10 : input.maxSteps,
  )
  return {
    ...result,
    library: input.library,
    entries: library.snapshot().map((entry) => ({
      ref: entry.ref,
      dependencies: entry.dependencies,
      supersedes: entry.supersedes,
      executions: entry.evidence.length,
    })),
  }
}

function capabilityLibraryCommand(input) {
  return capabilityLibraryRun(JSON.parse(input.text))
}

tools.command.define({
  name: "cap-library",
  description:
    "Run the decision-first loop with a persistent capability library; pass JSON { workspace, library, goal? }",
  handler: "capabilityLibraryCommand",
})
return { command: '/cap-library {"workspace":"/absolute/scratch","library":"/absolute/library.json"}' }
