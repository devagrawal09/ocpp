# Jev-First Repository Work

`/jev` is an opt-in daily-work entry point around the persistent capability
library. Jev owns batched judgments; generation authors executable behavior only
when the acquisition capability judges it necessary. No ordinary agent drives
the loop, and checks do not gate termination.

## Use

Execute `install.js` once in a fresh session notebook from this checkout. It
defines a session-local `/jev` command, with no need to install the older demo
commands. Existing notebooks can install it if the `jevDaily*` names are unused.
The installer binds the current directory as the default workspace and creates
a stable task identity. It reads the runner sources on each invocation, so
implementation updates do not require redefining notebook functions. This is
not yet a Location-wide command automatically available in every new session.

```text
/jev Find why cancellation leaves this session running and fix it.
/jev status
/jev resume
/jev Keep the API unchanged; focus on the Core implementation.
/jev new Add tests for the cancellation behavior.
```

Plain text starts a task or corrects the current one. `new <goal>` archives the
current task before starting another. `status` is read-only and invokes neither
model. Use a new task, not a correction, for unrelated work.

JSON options allow explicit workspaces, budgets, and generation models:

```text
/jev {"action":"new","goal":"Fix the parser bug","workspace":"/absolute/worktree","maxSteps":3,"maxGenerations":6}
/jev {"action":"resume","maxGenerations":8}
```

Defaults are three logical steps per invocation and six generation attempts per
task. The generation budget persists across resumes, including failed attempts;
zero is supported for reuse-only runs. `maxSteps` is 1-20 and
`maxGenerations` is 0-20. Generation defaults to the calling session's model,
using the generation tool's existing fallback. Override with
`model: { providerID, id, variant? }`; explicit choices persist for the task.

## What Runs

- Repository metadata, relevant package manifests, upward project instructions, and instructions associated with selected packages are gathered deterministically. Large instruction files are read across pages. Generated behavior must read narrower applicable instructions before editing.
- A source-search capability can gather evidence from significant goal words. Generated capabilities can inspect additional paths and use narrower searches rather than relying on a fixed source snapshot.
- Discovered package checks have independent usefulness and selection questions. Root test scripts guarded against root execution are excluded. Non-Bun projects can acquire their own inspection and verification behavior.
- All non-superseded library revisions join the repertoire unless retired for this task. The factory receives source, execution evidence, project instructions, and current observations.
- Every capability in a normal batch executes against the same prior context. All outcomes are applied before a quit judgment is honored.
- Progress, full-worktree diff, whitespace-check output, recent observations, budget counts, and a checkpoint path provide a reviewable handoff. A quit result is Jev's judgment, not an independent correctness verdict.

The original scratch-only experiments and their recorded 5/9 baseline are
unchanged. Daily work allows task-required test changes, with instructions not
to weaken tests, disturb unrelated work, stage, commit, push, or install
dependencies unless requested.

## State And Recovery

Judgments use a bounded view, including when resuming an already oversized
checkpoint: at most 8,000 serialized characters across state and questions.
The view selects the goal and the latest twelve observations after suppressing
superseded repository/library snapshots. Large values carry explicitly marked
head/tail previews, not generated summaries; an overly crowded view is itself
previewed to fit the ceiling. Full observations still reach
capability execution and remain in the checkpoint unless the ordinary compaction
capability replaces context. Unchanged repository discovery is not appended on
resume. Missing text in a preview is not evidence of absence or task completion;
capabilities must acquire narrower evidence when necessary.

Questions remain intact. More than 4,000 characters of questions produces a
local diagnostic before calling Jev rather than silently dropping capability
policies. Large repertoires may therefore still require narrower questions.
Informational goals should produce read-only explanations rather than run
checks merely because test scripts exist; this is judgment guidance, not a
filesystem sandbox or a correctness gate.

`/jev` requires the optional capability plugin and a running Core that exposes
`ctx.tool.evaluator`. The installer checks the invoking server's catalog before
reading runner sources or changing task state. If the evaluator is unavailable,
check `/api/plugin` on the **same server the UI uses**. Restarting an elected
service does not upgrade a separate, already-running development server. Either
restart that development server when its work can be interrupted, or reconnect
the UI to the updated service. Do not run the same task on both servers: they
can share notebook and checkpoint storage.

The default shared library is `~/.local/share/ocpp/jev/library.json`. Per-command
task checkpoints and archived histories live under the adjacent `tasks/`
directory. The library and task file formats are chunked JSON, so large strings
survive the read tool's paging and line limits. These files contain repository
content and tool output; treat them as local project data, not public telemetry.

An action is marked pending before execution and checkpointed afterward. On
interruption, completed observations remain durable. A resumed partial batch
skips already checkpointed capability IDs once, then returns to ordinary
judgments. An action interrupted before its outcome checkpoint may already have
had effects; recovery explicitly tells the agent to inspect rather than assume
rollback. This is not exactly-once execution or an atomic filesystem transaction.

Resume reconstructs source-backed capabilities in the current environment; it
does not serialize live closures or replay the interrupted interpreter stack.
Capability outcomes and history, not closure-local counters, carry durable work
state. Corrections apply on the next command invocation, not as mid-call steers.
Use the normal session stop control to interrupt; then inspect `/jev status`
before resuming or handing the task to an ordinary agent.

The outer confined runner explicitly requests up to 100 tool calls and 120
seconds. Generated capability calls keep the default 16-call/60-second ceiling.
Hitting a host limit can pause a run before its final report; checkpoints remain
available. Startup and execution costs still grow with the full active library;
this version has no retrieval or automatic pruning.

## Adoption And Limits

Start in an isolated worktree and review diffs. Use one shared library across
bounded real tasks and keep an ordinary agent as an explicit manual fallback.
The baseline diff is retained because the final worktree diff can also contain
pre-existing changes; untracked files appear in status but not `git diff`.

Use shared-library executions sequentially. There is no concurrent writer
coordination. Tool-path restriction is enforced, but repository-only access and
read-only shell usage are instructions, not a filesystem sandbox. Do not give
generated code authority you would not give a conventional coding agent.

Trace records include Jev judgments and usage when returned by the provider,
generation attempts, action outcomes, and verification evidence. Generation
tools still do not expose usage/cost; total economics remain unmeasured.
Command responses bound recent observations and diff previews; the checkpoint
retains the complete recorded history and tool-returned diff.

## Live Smoke

The installed `/jev` command was exercised on an additive-identity bug in an
isolated Git worktree. The first three generations returned invalid question
arrays and were rejected. After clarifying the source contract and selecting
`openai/gpt-6.1-sol`, an exact-file instruction discovery bug blocked one resume
before acquisition. Fixing that runner bug and resuming produced the one-line
repair and a Jev quit judgment. The task used six steps and five generation
attempts in total. An independent `bun test` passed, and the test bytes were
unchanged. This is a recovery smoke test with interventions, not an autonomous
real-task success rate or evidence of efficient capability acquisition.

The deterministic suite exercises real Git repositories, reads, patches,
checks, checkpoints, and the nested confined runner with scripted model outputs:

```sh
# From packages/core
bun test test/decision-capability-library.test.ts test/codemode-evaluator.test.ts
bun typecheck
```

Passing these tests is not evidence that this can autonomously replace most
agent work. That requires sequential real-task evaluation, intervention logs,
and cost measurements without clearing the library between tasks.
