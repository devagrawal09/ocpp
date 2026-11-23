# Persistent Capability Library

This is a separate, library-backed version of the decision-first experiment.
The original notebook, fixtures, and recorded 5/9 repeatability baseline are
unchanged. The library persists across executions and sessions that use the same
file; it is not a global registry installed in OC++ Core.

## Entry Point

In a fresh Code Mode notebook, execute `notebook.js`, then `library.js`. The
second script defines `/cap-library`:

```text
/cap-library {"workspace":"/absolute/scratch/task-one","library":"/absolute/scratch/library.json"}
/cap-library {"workspace":"/absolute/scratch/task-two","library":"/absolute/scratch/library.json"}
```

Both directories must already exist. Keep the library outside the task
workspaces so it does not enter their file observations. The library file is
created automatically after the first valid generation. Use a fresh notebook
when installing scripts: existing saved names cannot be redeclared.

The command accepts optional `goal`, `maxSteps` (default 10), and `model`
(`{ providerID, id, variant? }`). Generation defaults to
`openai/gpt-5.6-luna-fast`. Each execution allows at most two generation attempts.
The required tools are `decision.ask`, `generate.code`, `capability.evaluate`,
`glob`, `read`, `patch`, and `shell`, plus `command.define` during installation.
The checkout's opt-in capability plugin supplies the evaluator.

## Contract

Generated source declares metadata and a factory:

```js
const manifest = {
  id: "inspect-project",
  description: "Inspect the current project when its layout is unknown",
  dependencies: [],
  supersedes: [],
}

function createCapability(environment, library) {
  return {
    id: manifest.id,
    state: { workspace: environment.workspace },
    questions: {
      useful: { type: "noul", instructions: "Inspecting the project would help the goal." },
    },
    execute: (answers, context) => answers.useful.noul < 0.5 ? {} : {
      state: tools.shell({ command: "pwd", workdir: environment.workspace }),
    },
  }
}
```

`environment` contains the current `{ workspace, files }`, not the workspace
where the source was authored. Factories and metadata must have no tool effects.
Admission compiles and describes them with a zero-tool-call budget before saving
source. This validates loadability, not task correctness or generality.

Outcomes are JSON data: `{ state?, exit?, replaceContext?: array }`. Live
functions and returned capabilities cannot cross the evaluator boundary. The
host adapter validates outcome fields, preserves returned observation shapes,
records the result, and manages re-offering. The decision model
still judges all independent questions in a single batch, and each capability
owns its execution policy. No test or confidence gate is added to the loop.

## Composition And Supersession

References are explicit revisions, such as `inspect-project@1`. Each generation
receives existing source, descriptions, dependencies, active references, and
execution evidence. To compose a capability, declare its reference in
`dependencies`, then access `library["inspect-project@1"]`. The dependency is a
capability instance constructed for the current environment; its questions and
`execute` can be reused. The composite owns the mapping from its judgments to
the dependency's answers. Shared dependencies are instantiated once per
evaluator call, not duplicated.

To generalize or replace behavior, declare old references in `supersedes`.
Superseded source is retained and remains resolvable by existing compositions,
but is no longer offered independently in subsequent executions. New versions of
the same ID get monotonically increasing revisions. Merely reusing an ID does
not retire an older revision; supersession is explicit.

Supersession stops an adapter from re-offering itself. It does not change the
already judged batch, whose members execute against the same prior context.
Runtime failures retire adapters for that execution but retain source and
diagnostics in the library, allowing later reuse or repair. Loading failures are
reported in the library capability's state, without silently deleting entries.

The factory waits until execution evidence from loaded or newly admitted
capabilities is visible in prior context before attempting acquisition. Evidence
is saved even when a capability returns an empty outcome. This is an evidence
ordering rule, not a judgment or success threshold.

## Persistence And Limits

The JSON library contains a format version and a chunked serialized payload of
append-only source revisions. Bounded string chunks and paginated reads avoid
the read tool's per-line and per-page truncation, including for large source and
tool output strings.
Each entry records purpose, exact dependencies, explicit supersession, and
execution evidence (workspace, goal, judgments, result, and tool diagnostics).
Live closures and environment snapshots are not persisted as implementations.
Library writes are ordinary tool effects and survive a later execution failure;
they are not atomic with notebook saving.

This first version is deliberately small: all non-superseded entries become
active after the initial observation step, and generation sees the full library.
There is no semantic retrieval, automatic pruning, or claim of bounded cost as
the library grows. Evidence is retained, not silently compacted. Use executions
sharing a library sequentially: the file writer has no concurrent merge/locking.

The evaluator restricts available tool paths, not filesystem paths. Scratch-only
access, read-only shell usage, and test integrity are generation instructions,
not a filesystem sandbox. Persisted generated code remains executable code and
should only be reused with the same deliberate authority as newly generated code.

## Verification

From `packages/core`:

```sh
bun test test/decision-capability-library.test.ts
bun typecheck
```

The tests run the actual notebook scripts through Code Mode and the Core confined
evaluator. File reads, patches, library reloads, shell checks, and independent
fixture tests are real. Only generation and decision outputs are scripted for
determinism. Coverage includes cross-execution reuse in different workspaces,
pinned composition after supersession, generation context and evidence ordering,
invalid admission and execution outcomes, preserved observation shapes, failure
evidence, corrupt-library rejection, and large-library pagination.

These tests establish mechanism correctness, not learned capability transfer or
an economic advantage. The next empirical evaluation should retain one library
across related but varied tasks and measure success, generation frequency, total
cost, and recovery against a conventional agent.
