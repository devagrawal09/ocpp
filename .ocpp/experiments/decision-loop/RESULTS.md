# Capability Loop Repeatability

The unchanged decision-first loop completed 5 of 9 isolated trials. This extends
the earlier median proof but does not establish general reliability.

## Method

- Three bug fixtures, three fresh workspaces each; all nine failed before execution.
- Same generic goal, base capabilities, generation prompt, model, two-generation budget, and ten-step bound throughout.
- The actual generation model was `openai/gpt-5.6-luna-fast`; Jev supplied batched judgments.
- No manual edits or tuning during trials. Repeats ran in groups with concurrent work on separate directories.
- Tests independently measured the result after the loop stopped. They never gated termination.
- Every original test file was compared byte-for-byte with its prepared snapshot.
- Timings include live provider and tool latency under concurrent load; they are not a speed comparison.

## Outcomes

| Fixture | Passed | Stop Reasons | Elapsed Seconds |
|---|---:|---|---|
| Query values: embedded equals and form decoding | 1/3 | limit, quit, limit | 27.3, 34.5, 32.1 |
| Cross-file config: preserve explicit falsy values | 3/3 | quit, quit, quit | 19.5, 28.9, 24.0 |
| Async cache: evict rejected requests | 1/3 | limit, limit, quit | 33.9, 42.5, 26.1 |

All five quits had passing tests. All four limit stops still had failing tests.
Test integrity passed 9/9. No false-success quit or successful-but-stalled run was observed.

Median elapsed time was 28.9 seconds. The suite used 18 generation calls and 58
batched decision calls. Jev reported 188,006 input tokens and 5,084 output tokens.
Generation usage is not exposed by the current tool, so no total-token or cost
claim is made.

## Failure Analysis

Generated code repeatedly compared shell output with a hand-written whole-file
string missing the trailing newline. The actual file did not match, so a
proposed repair never executed. The final generated source in all four failed
trials contained this brittle comparison.

Three trials encountered malformed patch hunks; two recovered and one stalled.
One trial generated unsupported regular expressions and recovered on its second
generation. The interpreter and patch gateway correctly refused these operations.

Every run used both generation attempts. In particular, a second capability can
be generated before the first capability's execution outcome is visible because
all capabilities execute against the same prior context. The generation budget
does survive compaction, but early consumption can leave no repair opportunity
after an execution error or a repeated no-op.

The failure here is mostly generated action reliability and recovery, not a
premature quit judgment. The next focused experiment should reduce brittle edit
construction and preserve generation capacity for post-execution evidence,
without introducing a single-capability router or test-gated termination.

## Reproduction And Evidence

Prepare fixtures with `bun .ocpp/experiments/decision-loop/fixtures.ts prepare <fresh-absolute-root>`.
In a session with the experiment's notebook functions installed, install
`trial.js` and invoke `/cap-trial <workspace>` for each manifest entry exactly once.
Wait for every command completion before verifying.

Verify with `bun .ocpp/experiments/decision-loop/fixtures.ts verify <root>`.
Preparation refuses to overwrite a manifest. Trace files live outside each
workspace so they do not enter generation context. Verification writes full
test output, stop reasons, timings, generation counts, errors, and Jev usage to
`verification.json` and prints a compact summary.

This run's root was
`/private/var/folders/k4/g2_9q0g52437sbcp5m856r6m0000gn/T/ocpp/capability-repeatability`.
It contains `manifest.json`, nine `trace-*.json` files with generated source and
decisions, and `verification.json`. The live wrapper was
`capabilityTrialRepeatability`, calling the previously installed
`capabilityDemoChecked`; the on-disk equivalent uses the current unversioned names.

Selected tool paths are enforced, but shell/patch retain broad authority.
Scratch-only access remains a prompt instruction, not a filesystem sandbox.
Fixtures are small, all are failing-test repair tasks, and only one generation
model was used. These results are not comparable to the older prototype or an
ordinary-agent benchmark.
