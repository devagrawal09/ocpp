# Code Mode Transcript and Source Review

## Findings

1. **High: Completion delivery dominates context and storage.** A scoped snapshot found 753 completions totaling 8.95M characters: median 3.6K, p90 43.1K, p95 65.7K, and max 104.6K. The largest 13.3% contributed 61.3% of all completion text. Main executions use a 64 KiB result/log budget, but warnings receive a separate equal budget, so formatted output can exceed 64 KiB (`packages/codemode/src/interpreter/execute.ts:240-303`, `packages/core/src/codemode/tool.ts:36-39`). The full output is then stored in the durable completion event, assistant metadata, and synthetic message (`packages/schema/src/session-event.ts:576-584`, `packages/core/src/session/message-updater.ts:321-333`, `packages/core/src/session/codemode-completion.ts:29-36`). A live join measured 13.70M synthetic characters and another 13.60M in matching assistant metadata.

2. **Medium: Raw tool output receives user-role attribution.** Code Mode inserts unescaped output inside `<codemode>...</codemode>` and all synthetics lower as `role: "user"` (`packages/core/src/session/codemode-completion.ts:34`, `packages/core/src/session/runner/to-llm-message.ts:256-257`). Normal tool output uses a provider tool-result block. File, shell, web, or MCP content containing instructions or `</codemode>` can therefore appear more authoritative or spoof the wrapper. Permissions still gate subsequent actions, so this is a prompt-injection and correctness risk, not a sandbox bypass.

3. **High: Compaction does not fix the context problem reliably.** Tool and shell results are truncated to 2,000 characters during compaction, but synthetics are serialized whole (`packages/core/src/session/compaction.ts:110-122`, `packages/core/src/session/compaction.ts:164`). The recent tail is also retained verbatim. In the measured sample, 52.8% of Code Mode completion characters remained active after the latest compaction.

4. **Medium-high: Custom subagent tools have an actually unbounded path.** `packages/core/src/tool/plugin/subagent-custom.ts:111-113` supplies only the optional caller timeout. With it omitted, execution has no timeout, tool-call ceiling, or output limit, and the resulting content enters model history normally. This should share an explicit execution-limit policy with the main Code Mode host.

5. **Medium: Async completion permits premature final answers.** `execute` deliberately returns only an execution ID and starts after the outer tool result commits (`packages/core/src/codemode/tool.ts:224-287`). Later results steer the session, but nothing distinguishes required work from intentionally detached work. Transcripts contained final/progress answers followed by still-running executions. A blanket prohibition would be wrong; required versus detached execution must become explicit.

6. **Medium: Error categories exist but are flattened before reaching the model.** Host failures are correctly wrapped as `ToolFailure` (`packages/codemode/src/tool-runtime.ts:536-546`, `packages/codemode/src/interpreter/errors.ts:28-29`). However, `formatResult` drops `error.kind` and returns only prose (`packages/core/src/codemode/tool.ts:412-424`). The model therefore cannot reliably distinguish parse, tool, timeout, or runtime failures. The categorized transcript sample had 28 invalid-regex failures, making this materially useful.

7. **Important scope limitation:** these transcripts evaluate the global sole-tool experiment, not stock V2. `.opencode/plugins/codemode-only.ts:3-43` moves twelve built-ins behind `execute` and removes their native definitions. Stock built-ins such as grep explicitly use `codemode: false` (`packages/core/src/tool/plugin/grep.ts:71`). Conclusions about regex failures, built-in orchestration, and sole-tool productivity must not be generalized to stock V2 without an A/B run.

## Verdict

Code Mode is net helpful in this experiment. Of 1,056 later workspace executions, 540 used `Promise.all`; major sessions used it in 28/38 and 191/339 executions. It successfully collapses parallel discovery, filtering, and subagent work into one model action.

The interpreter and async job architecture are not the primary problems. The host delivery boundary is: excessive repeated output, wrong role attribution, durable duplication, flattened diagnostics, and ambiguous pending-work semantics. The fixed catalog cost is around 2,000 estimated tokens for the twelve experimental tools; completion history is the much larger variable cost.

## Recommended Design

1. Add a Code Mode-specific model projection immediately: UTF-8-safe head/tail preview capped at 16 KiB, explicit untrusted-output framing, delimiter neutralization, total byte count, and execution ID. A later snapshot indicates 16 KiB would affect 22.3% of completions while removing 47.6% of completion text.

2. Apply the same bound in compaction, independently of delivery. This protects existing sessions and prevents the recent tail from retaining historical oversized synthetics.

3. Persist one structured execution result keyed by `executionID`, including diagnostic kind, value, warnings, logs, and byte counts. The background Job KV is not suitable: `completeBackground` deletes it after notification delivery (`packages/core/src/job.ts:527-529`). Assistant metadata can serve as a transitional retrieval source, but a dedicated result store is the coherent endpoint.

4. Return full or paginated output through a native tool-result channel. A small direct `execution_result` tool is clearest. If preserving one-tool purity is mandatory, add a synchronous retrieval variant to `execute`; its response would still lower as a normal tool result.

5. Once retrieval exists, make the synthetic contain only trusted completion status and the result reference. Remove full output from assistant metadata and the durable public completion event, using an additive transition because old persisted sessions and external event consumers are concrete compatibility concerns.

6. Add shared limits to custom subagent execution. Instrument actual tool-call fanout before choosing a ceiling, but add an output cap and finite program timeout now.

7. Preserve `[DiagnosticKind]` in model-facing failures. Add `literal: true` or equivalent fixed-string support to grep and recommend it directly in invalid-regex diagnostics.

8. Introduce required versus detached execution semantics. Required executions should prevent a completion claim or trigger a clear pending-work reminder; detached executions should retain current background behavior.

## Defer

- Exact output deduplication: normalized duplicates were only about 1.1% of payload.
- Lowering the interpreter's 64 KiB cap as the primary fix: it destroys data before retrieval and does not address role attribution or durable duplication.
- Automatic restart replay: tool side effects are not generally idempotent.
- Moving permissions into `packages/codemode`: host authorization is intentionally Core-owned.
- Making the sole-tool plugin a stock default before controlled plugin-on/plugin-off benchmarks.

## Fable Cross-Check

Claude Code with Fable was run in multiple read-only review passes. It independently confirmed the delivery, compaction, custom-limit, and role-attribution findings. Its assumptions about the global plugin, host-error classification, and Job KV durability were corrected against the source.

No implementation files were changed as part of this review.
