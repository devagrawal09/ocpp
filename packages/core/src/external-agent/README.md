The `claude`, `codex`, and `pi` tools delegate synchronously through a shared gateway. Each call creates or continues an ordinary OpenCode child Session. The OpenCode ID is the caller's continuation token; vendor IDs remain internal.

`session_external` is keyed by the child ID. Internal bound, linked, and checkpointed events project the provider, directory, vendor identity, and history checkpoints. Ordinary Session execution events project lifecycle state. Session deletion cascades to the external record. A per-session reservation protects admission and history checks; scoped activations retain private input and delegated handles until SDK cleanup finishes.

Continuation checks both canonical child history and the exact vendor history before admitting another prompt. A missing vendor session is rebuilt with canonical child history and its replacement ID is persisted. Divergent history fails closed. After a process restart, a fresh external-tool call supplies a new machine activation; stale tool handles are never restored from storage.

The common call accepts `directory`, `description`, `message`, optional `sessionID`, model/effort overrides, private `input` plus `inputSchema`, opaque `tool.define` handles, and `outputSchema`. Results contain `{ sessionID, status, message, output }`. The caller model sees only the child ID, status, and message. Private input is a confined execute-program binding; notebook declarations and structured output are excluded from model-facing tool results. Explicit execute previews and logs remain model-visible, as in direct Code Mode. Schema failures do not echo private values.

The gateway validates both sides of each ToolHandle invocation and preserves the handle's original capability and activation checks. Custom tools with non-object input schemas are available through `execute`, avoiding invalid native MCP schemas. A valid structured submission closes further gateway calls. Claude interrupts after the SDK acknowledges tool completion, and Pi stops at its post-tool boundary. Codex drains its SDK completion because that SDK publishes aggregate usage only at the terminal boundary. Codex `error` events and error items are recoverable notices (retries, warnings) recorded as diagnostics; only `turn.failed` or a failed exec exit fails the run, and a failed run's own error always takes precedence over an unreadable post-run checkpoint. Claude and Pi adapt this gateway in process. Codex receives an ephemeral loopback MCP endpoint with a per-call bearer credential; the credential never enters prompts, URLs, or transcript events.

All roots must be existing absolute directories and pass OpenCode provider and external-directory permission checks. Child placement may differ from parent placement, including separate git worktrees. Claude and Pi also authorize native tool calls through OpenCode while preserving vendor permission hooks and sandbox policy. Native paths use the SDK working directory, relative path rules, and external-directory checks. Native shell commands use OpenCode's shell scanner to retain restrictions on individual commands. Claude hook errors explicitly deny execution. Claude Agent and Task tools and Codex multi-agent support are enabled. Codex's execution SDK has no per-tool approval callback: native read, edit, and shell delegation requires up-front authorization for the complete scope, including configured restricted resources. Its native sandbox is `workspace-write`, shell network access is disabled, managed web search is live, and approval is `on-request` so configured MCP tools can run while unsandboxed escalation still fails.

Readiness is cached for the Location/config lifecycle and refreshed on config changes. Claude and Codex require their installed CLI and authentication; Pi uses its SDK model runtime's authentication snapshot. SDK imports are lazy. The workerd/default platform adapter exposes no external tools and imports no vendor runtime.

Configuration:

```json
{
  "external_agents": {
    "claude": { "enabled": true, "model": "sonnet" },
    "codex": { "enabled": true, "model": "gpt-5.6-sol" },
    "pi": { "enabled": true, "model": "anthropic/claude-sonnet-4-6" }
  }
}
```

Each provider also accepts a configured `effort`; per-call values take precedence. Provider drivers validate effort against their installed SDK types.

Pinned SDKs: Claude Agent SDK `0.3.266`, Codex SDK `0.153.4`, and Pi coding-agent SDK `0.85.1` (`@earendil-works/pi-coding-agent`). Codex's execution SDK lacks history reads, so a temporary app-server loads the exact persisted thread without prompting and reads complete legacy or paginated history. The history probe uses read-only sandboxing and denies approvals. T3 Code's ACP lifecycle and Codex history pagination at commit `4a4c6dd2adc350a68ba18bb28b24b5a7e4660dab` informed the separation between SDK transport, normalization, and Session projection.

Run deterministic tests from `packages/core`:

```sh
bun run test test/external-agent-tool.test.ts test/external-agent-gateway.test.ts test/external-agent-driver.test.ts
bun typecheck
bun run migration --check
```

`test/external-agent-live.test.ts` is explicitly opt-in through `OPENCODE_EXTERNAL_LIVE=claude,codex,pi`. It sends real model requests using vendor authentication and tests private structured output plus exact continuation. Model overrides use `OPENCODE_EXTERNAL_LIVE_CLAUDE_MODEL`, `OPENCODE_EXTERNAL_LIVE_CODEX_MODEL`, or `OPENCODE_EXTERNAL_LIVE_PI_MODEL`. It is separate from the deterministic suite.
