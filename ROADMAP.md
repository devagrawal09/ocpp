# Roadmap

This is the central guide for planned OC++ work. Read it before choosing or
scoping a task, and update it when priorities, scope, or completion change.

The roadmap owns priorities and intended outcomes. GitHub issues hold detailed
task discussion and implementation tracking; link them from the relevant item
when available. [V2 specifications](specs/v2/README.md) explain current contracts,
not future commitments. Source and tests remain authoritative for shipped behavior.

## Working Rules

- Work from Now first unless a user explicitly requests something else.
- Keep items outcome-focused, with a concrete completion criterion.
- Label work as planned, in progress, or blocked; record the blocker when blocked.
- Do not treat an entry as permission to change public contracts or expand scope.
- Move completed items to Completed with a short result and a PR or commit link when available.
- Keep speculative ideas in Later until their scope and priority are agreed.

## Now

### Raise Code Mode Execution Allowances

Status: planned; highest priority.

Goal: raise overly restrictive Code Mode allowances so useful tool-composition
programs can finish without prematurely hitting execution limits.

Completion criteria:

- Inventory the effective host and interpreter limits, including execution duration, tool-call count, output/log budgets, and notebook value sizes.
- Identify limits that block real workloads and raise the relevant defaults, checking nested evaluation and subagent calls for lower effective ceilings.
- Verify representative long-running, multi-tool, and larger-data programs that previously exhausted their allowances.
- Preserve cancellation, bounded resource use, and atomic notebook saving; keep diagnostics explicit when a limit is reached.
- Update limit documentation and regression tests with the new allowances.

### Cancellation Fixes

Status: planned.

Goal: make stopping work reliable and make the scope and outcome of cancellation
clear to the user.

Completion criteria:

- Reproduce and fix cancellation failures across session execution, Code Mode tool calls, and owned subagent work.
- Test interruption during model streaming, tool execution, and child-session execution, plus cancellation of queued work where supported.
- Preserve atomic notebook saving and distinguish user cancellation from shutdown recovery.
- Ensure stopping one session does not interrupt unrelated sessions.
- Show accurate stopping and terminal states, with regression tests for the affected paths.

### Code Mode Performance Baseline

Status: planned.

Goal: measure interpreter overhead and durable execution scaling before making
performance changes. Separate runtime costs from database, tool, and model latency.

Initial scope:

- Benchmark compilation and precompiled evaluation of representative tool-composition programs in `packages/codemode`.
- Measure schema-described tool dispatch while varying call count and argument/result size.
- Compare sequential and parallel controlled-delay tools, asserting that concurrency is preserved.
- Measure a small execution against a growing persisted notebook in `packages/core`, varying binding count and encoded bytes independently.
- Measure restart/resume and assert that completed journaled tool calls are not executed again.

Completion criteria:

- Reproducible package-local benchmark commands and deterministic fixtures, without live model or network dependencies.
- Separate compilation, evaluation, and host persistence timings where practical.
- Machine-readable results with workload sizes, revision, Bun version, machine details, sample count, and latency distributions.
- Cold and warm runs distinguished; memory measurements reported with their measurement method.
- Correctness assertions accompany timings, including saved declarations, concurrency, and recovery behavior.
- A recorded baseline and documented interpretation of results. Regression thresholds follow baseline collection, rather than arbitrary initial targets.

## Next

### UI Improvements

Status: planned.

Goal: improve everyday session navigation and interaction while preserving the
existing visual language.

Completion criteria:

- Identify and address concrete friction in session navigation, composer interactions, and loading, empty, and error states.
- Keep primary actions discoverable and provide clear feedback when work is running or an action fails.
- Verify affected flows on desktop and mobile, with keyboard accessibility and RTL behavior covered.
- Add focused UI regression coverage for the improved interactions.

### Subagent Process UI

Status: planned.

Goal: make delegated work understandable without requiring users to navigate
blindly between parent and child sessions.

Completion criteria:

- Show each subagent's task, relationship to its parent, and current execution status.
- Make progress, results, errors, and cancellation outcomes accessible from the parent session.
- Provide clear navigation into child sessions and back to the originating work.
- Keep concurrent subagents distinguishable and verify live updates and restored session views.

### Code Mode Process UI

Status: planned.

Goal: make Code Mode executions and their tool activity visible as coherent
processes rather than opaque execution IDs.

Completion criteria:

- Show execution status, source, tool-call activity, and completion outcomes.
- Surface saved notebook names, diagnostics, and cancellation or indeterminate outcomes.
- Make parallel tool activity understandable without obscuring execution order or overwhelming the session timeline.
- Verify that live and restored views agree with persisted execution state.

### Session Logs UI

Status: planned.

Goal: make session activity and failures easy to inspect without reading raw
service logs.

Completion criteria:

- Present available session logs and execution diagnostics with clear source attribution and chronological ordering.
- Support searching or filtering and copying relevant entries for debugging.
- Distinguish logs, tool activity, and user-visible messages, and make truncation explicit.
- Preserve reading position while new entries arrive and keep large log views responsive.
- Cover live updates, restored sessions, empty states, and failure states in UI tests.

### Broader Code Mode Performance Coverage

Status: planned; depends on the initial performance baseline.

Goal: identify costs that emerge in long-lived sessions and concurrent workloads.

- Cover durable function captures, collection transforms, large outputs/logs, and limit rejection.
- Measure notebook growth across repeated executions and increasing execution history.
- Measure per-call journal/trace overhead and contention across concurrent sessions.
- Compare speculation enabled and disabled for independent reads and dependent/barrier-heavy programs, including useful and wasted speculative work.

Complete when these workloads have reproducible measurements and findings that
identify concrete optimization candidates or confirm acceptable scaling.

## Later

### Agent-Level Code Mode Evaluation

Status: proposed.

Compare Code Mode with ordinary tool calling in a separate evaluation harness,
holding the model, tools, and tasks constant. This is an experiment, not a change
to OC++'s single model-facing `execute` contract.

Use tasks involving discovery, filtering, joins, parallel reads, saved-function
reuse, and error recovery. Track task success, wall time, model tokens, logical
LLM steps, tool calls, and retries. Keep provider-dependent results separate from
deterministic per-PR performance checks.

Promote this work when the evaluation harness and comparison methodology are
agreed; complete it with a repeatable task set and a report of quality and cost.

## Completed

### Jev-First Repository Command

Implemented an opt-in session-local `/jev` command with progressive repository
discovery, project instructions, persistent cross-task capability reuse, bounded
generation budgets, per-action recovery checkpoints, corrections, and reviewable
handoffs. The installed command repaired an isolated worktree fixture after
failed acquisitions and an instruction-discovery fix; independent tests passed
with test bytes unchanged. The smoke task used six steps and five generation
attempts, not an untuned reliability benchmark. Deterministic mechanism tests
also cover reuse, nested evaluation, partial-batch recovery, and instruction paging.

The recorded scratch-loop baseline is unchanged. Full-library activation,
sequential writers, manual fallback, and next-invocation corrections remain
explicit limits. Broad daily-task reliability and economic advantage are not
validated. See [usage and limits](.ocpp/experiments/decision-loop/JEV.md).
Oversized-checkpoint recovery now uses a bounded judgment view without rewriting
the full execution context, and resumes skip unchanged repository discovery.
Regression tests cover large/escaped inputs, recovery, and explicit question
budget diagnostics; broad-task judgment quality remains unvalidated.
The command now checks evaluator availability before touching task state. A
separate development server that predates the evaluator API must be restarted
or its UI reconnected to the updated service; restarting the elected service
alone does not update that process.

### Persistent Decision-First Capability Library

Status: completed; explicitly requested extension of the capability-loop experiment.

Added a separate library-backed execution command without changing the recorded
5/9 baseline. Validated generated source is saved automatically and reloaded in
later executions with the current workspace. Generation receives existing source
and execution evidence and can compose pinned revisions or explicitly supersede
narrow capabilities without deleting dependencies. Acquisition waits for prior
execution evidence; the existing batched decision loop and capability-owned
execution policies are unchanged.

Deterministic tests cover cross-workspace reuse, composition after supersession,
generation context, evidence ordering, invalid admission, and retained failure
diagnostics. These checks prove mechanism behavior, not autonomous transfer or
cost improvement. Shared-library executions are sequential in this initial version.

See [contract, usage, and limitations](.ocpp/experiments/decision-loop/LIBRARY.md).

### Decision-First Capability Loop: Repeatability Phase

Status: completed; explicitly requested experiment, separate from the performance baseline.

The median proof demonstrated generation and next-step execution with Jev-owned
termination. The unchanged loop then passed 5/9 trials across three fixtures,
three isolated repeats each. Tests were unchanged in all runs; the four failures
hit the step bound, with no false-success quits. Complete traces and independent
verification were recorded. Brittle file comparisons, malformed generated patches,
and early generation-budget consumption remain limitations, not solved reliability.

See [methodology, results, and reproduction](.ocpp/experiments/decision-loop/RESULTS.md).
No general-reliability or total-cost claim is made.
Implementation and evidence: [6f310d25c6](https://github.com/devagrawal09/ocpp/commit/6f310d25c6).
