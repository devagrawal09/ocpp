Claude Code, Codex and Pi are session drivers. A driver runs a Session instead of the OC++ runner, using the user's own vendor CLI login or key. A Session's driver is the provider of its model: `claude/opus` is driven by Claude Code, `codex/gpt-5.6-sol` by Codex, `pi/anthropic/claude-sonnet-4-6` by Pi, and any provider model by the OC++ runner (`ocpp`). Choosing a driver is choosing a model, at creation (`session.create`) or later (`session.switchModel`), and the model variant is the vendor's reasoning effort. `GET /api/model/driver` lists each driver with its readiness, default model, suggested models and efforts; the web app offers the ready ones in the model picker.

`SessionExecution` routes a vendor-driven Session to `ExternalAgentHarness` in the Session's Location. The harness is not a model provider inside `SessionRunner`: it owns its own drain. Prompts still enter through the durable inbox. At each boundary the harness promotes inbox items exactly as the runner does (steers first; at an idle boundary one queued item; compaction is refused and a move ends the drain), renders the promoted messages as text, and delivers them to the vendor session. Vendor events project into the Session as ordinary assistant messages through `ExternalAgentStream`. A drain keeps its vendor session alive until the vendor is idle and every Code Mode execution it started has delivered its completion notification, so a vendor that launches work and waits is woken with the result. Claude receives steers and notifications mid-turn through streaming input (the CLI folds them in at its next boundary); Codex and Pi receive them when their turn ends.

## Harnesses

A top-level Session always runs in the OC++ harness. A subagent defaults to it and may ask for the native harness.

In the OC++ harness the vendor's only capability is OC++'s full `execute` for that Session: the same Code Mode catalog, permissions, durable notebook, journaled calls and compile checks a native model gets, with each run's trace in the Session timeline. The vendor's system prompt is replaced by the one OC++ assembles for a native model (`SessionModelRequest.systemPrompt`: the agent or OC++ prompt with its Code Mode rules, plus the current instructions, catalog and subagent guidance).

- Claude: `tools: []`, the OC++ `systemPrompt`, `settingSources: []`, `strictMcpConfig: true`, `skills: []`, the in-process `ocpp` MCP server as the only server, `allowedTools: ["mcp__ocpp__execute"]` and `permissionMode: "dontAsk"`. Claude Code still prepends one identity line ("You are a Claude agent, built on Anthropic's Claude Agent SDK.") and adds its own environment and token-budget `<system-reminder>` blocks to user turns.
- Codex: every native tool feature off (`shell_tool`, `unified_exec`, `multi_agent`, `multi_agent_v2`, `view_image`, `browser_use*`, `in_app_browser`, `computer_use`, `image_generation`, `apps`, `plugins`, `remote_plugin`, `sleep_tool`, `tool_suggest`, `skill_search`, `skill_mcp_dependency_install`, `code_mode*`, `goals`, `memories`, `hooks`, `standalone_web_search`, `request_permissions_tool`), web search disabled, the OC++ prompt as `model_instructions_file`, Codex's apps, permissions, environment, collaboration and skills instructions off, the user's own MCP servers disabled (from `codex mcp list --json`), no project `AGENTS.md` (`project_doc_max_bytes = 0`), and a copy of Codex's model catalog without `tool_mode`, `multi_agent_version` or deferred tool search, so `execute` is offered directly instead of inside Codex's own code mode. The OC++ MCP server is approved (`default_tools_approval_mode = "approve"`) because exec mode cannot ask. What remains: `apply_patch` (it cannot be switched off; the `read-only` sandbox rejects every write), `list_mcp_resources`, `list_mcp_resource_templates` and `read_mcp_resource` (only the OC++ server is loaded and it has no resources), and `request_user_input` (Plan mode only). Known limit: Codex has no switch for the global `$CODEX_HOME/AGENTS.md`, so it still reaches the model as user instructions. Pointing `CODEX_HOME` at a scratch directory would need a copy of the user's credentials, and a token refresh there could rotate them and sign the user out of their own Codex. The bridge credential reaches Codex through `bearer_token_env_var` and its environment, never its command line.
- Pi: `noTools: "builtin"` (no read, bash, edit or write) with `execute` as its only custom tool, and a resource loader with no extensions, skills, prompt templates, themes or context files and the OC++ `systemPrompt`. Pi appends one "Current working directory" line.

In the native harness (subagents only) the vendor keeps its own tools, prompt and settings. OC++ adds its full `execute`, the call's `tool.define` handles and `submit_result` over MCP (or as Pi custom tools). Native calls are authorized through OC++ as before: Claude hooks and `canUseTool` check each call, native shell commands go through OC++'s shell scanner, and paths outside the directory need `external_directory`. Codex has no per-tool callback, so the complete `read`, `edit` and `shell` scope is authorized up front and its `workspace-write` sandbox runs without network, with live web search. The Session timeline shows the vendor's native tool calls.

Native permissions are checked against the child's agent (the old `tools.claude` and `tools.codex` checked the caller's). A request that a child tool part explains is asked in the child; any other, such as Codex's up-front scope, is asked of the caller and names the subagent call. OC++'s own tools are never checked as vendor tools: `execute` enforces permissions inside, and `tool.define` handles and `submit_result` are capabilities the call delegated, so a read-only agent such as `explore` can still submit. Native Claude runs its sandbox, which on Linux needs `bubblewrap` and `socat`; without them Claude Code refuses with "Sandbox required but unavailable".

## Subagents

`tools.subagent` takes `driver` (`ocpp`, `claude`, `codex`, `pi`) and `harness` (`ocpp`, `native`). Unless the call names a driver, a continued child keeps its own, and a new child takes the driver of its agent's configured model (`claude/opus` selects Claude Code, any other provider the OC++ runner), else its caller's. `harness` defaults to `ocpp` and is never inherited; `native` with the `ocpp` driver is refused. For Claude Code and Codex, `model` is the vendor's model name without a provider, with an optional effort after `#` (`opus#high`); for Pi it is Pi's `provider/model`. A model ID of the wrong shape fails before any vendor starts. Every other subagent input works unchanged: `input` and `inputSchema`, `tool.define` handles, `outputSchema` with `submit_result`, continuation by `sessionID`, and restart reattachment. A subagent call lends a vendor child its harness and tools while it holds the child (`ExternalAgentSession.activate`); it first lets a drain the child is already running on its own finish. Without a call, a vendor child drains like a top-level vendor Session, in the OC++ harness: a direct prompt or a late completion notification is answered.

A vendor child is authorized with the vendor's action and the model ID as its resource (`claude`, `codex` or `pi` on `opus`), replacing the old tools' directory, `external_directory` and `model` checks. `subagent.models` and the `subagent_model` permission apply only to children on the `ocpp` driver.

## Continuation

`session_external` keeps one vendor binding per Session: provider, directory, vendor session ID, the vendor-history checkpoint and the hash of the canonical history it answered. Canonical history is what the runner would show a model, reduced to text: messages, each tool call's name and input, and each result's model-visible content. Tool metadata never enters it, so a Code Mode trace (with assignment values, private `input` and submitted output) never reaches a rebuilt vendor session, and a completion that rewrites the trace after the checkpoint does not force a rebuild. Binding again (another vendor, or a moved Session) starts a new vendor session. A drain resumes the vendor session only when both the canonical history hash and the vendor's own history fingerprint match the last checkpoint; otherwise it starts a new vendor session rebuilt from canonical OC++ history. Input the vendor never answered (for example the continuation prompt after a restart) is delivered again once. Startup recovery resumes claimed top-level vendor Sessions like any other. User interruption aborts the vendor run; its partial step is recorded as interrupted.

## Readiness and configuration

A driver is ready when it is not disabled in `external_agents` and its CLI and login are present: `claude auth status`, `codex login status`, or a Pi provider with configured auth. Only the first probe is awaited; after five minutes its answer is still served while one background probe refreshes it, so no step waits on a vendor CLI. `OCPP_DISABLE_EXTERNAL_AGENTS=true` offers no drivers without probing (the core, server and CLI tests set it). A drain of an unready driver fails the Session with a message that says how to fix it. The web app lists ready drivers in the model picker but not among connected providers: their login belongs to the vendor CLI.

```json
{
  "external_agents": {
    "claude": { "enabled": true, "model": "sonnet", "effort": "high" },
    "codex": { "enabled": true, "model": "gpt-5.6-sol" },
    "pi": { "enabled": true, "model": "anthropic/claude-sonnet-4-6" }
  }
}
```

Pinned SDKs: Claude Agent SDK `0.3.266`, Codex SDK `0.153.4`, and Pi coding-agent SDK `0.85.1`. Codex's execution SDK lacks history reads, so a temporary app-server loads the exact persisted thread without prompting and reads complete legacy or paginated history. SDK imports are lazy; the workerd platform adapter offers no drivers.

Run deterministic tests from `packages/core`:

```sh
bun run test test/external-agent-harness.test.ts test/external-agent-driver.test.ts
bun typecheck
```

`test/external-agent-live.test.ts` is explicitly opt-in through `OCPP_EXTERNAL_LIVE=claude,codex,pi`. It sends real model requests through each SDK in the OC++ harness. Model overrides use `OCPP_EXTERNAL_LIVE_CLAUDE_MODEL`, `OCPP_EXTERNAL_LIVE_CODEX_MODEL`, or `OCPP_EXTERNAL_LIVE_PI_MODEL`.
