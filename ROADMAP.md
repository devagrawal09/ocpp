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
