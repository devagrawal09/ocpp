# OC++

OC++ is an open source AI coding agent. It ships as the `ocpp` command: running `ocpp` starts a local background server if needed and opens the OC++ web app in your browser, while subcommands such as `ocpp run`, `ocpp serve`, and `ocpp acp` work from the terminal and other tools. It reads its own `ocpp.json` configuration and is developed and released as its own product.

OC++ is forked from [OpenCode](https://github.com/anomalyco/opencode). It is an independent project: it is not an OpenCode branch, edition, or distribution, and it is not affiliated with or endorsed by the OpenCode project. Upstream Git history and the MIT license are preserved, and OpenCode retains copyright in the code inherited from it.

> [!NOTE]
> OC++ has not published release artifacts yet. The installation commands below describe the intended channels; until they are live, build from source with `bun install` and `bun run dev`.

### Code Mode

OC++ models Code Mode as an append-only durable notebook that a Session writes to by running code:

- **One model tool:** The model is only ever offered `execute`. Built-in tools, MCP servers, subagents, external agents, and plugin tools are reachable only from the code it runs, as `tools.<namespace>.<name>(input)`.
- **Automatic publication:** Every direct top-level `const` and `function` declaration is saved to the Session notebook and readable by name in later executions. There is no `export` syntax, and `return` is only a small preview.
- **Immutable names with atomic admission:** A notebook name is written once and never reused. Names are verified and reserved before an execution ID exists, so conflicts are refused immediately and disjoint executions run concurrently without a global revision gate.
- **All-or-nothing saving:** A successful program commits every declaration in one transaction; any failure, cancellation, or revert saves nothing and releases its reservations.
- **Durable values, including closures:** Values are `null`, booleans, finite numbers, strings, immutable arrays, string-keyed records, and functions saved with their compiled body and exact captures. `Date`, `Map`, `Set`, and `URL` are replaced by `time` and `url` helpers that return plain data; regular expressions are unavailable.
- **One asynchronous flow:** `execute` takes source code only, returns an execution ID after admission, and delivers one bounded completion notification with status, saved names, diagnostics, and logs. Mode, model-supplied timeouts, durable result blobs, and `execution_result` paging are gone.
- **Durable lifecycle and recovery:** Executions, tool-call journals, notebook values, fork boundaries, and committed reverts are persisted by Core. After a crash or restart, a running execution resumes by replaying its program against its journal: completed tool calls are served from the journal instead of running again, and it continues live from the first call without a result. An in-flight call reruns only when its tool is read-only, and a subagent call rejoins its child session; any other in-flight call leaves the execution `indeterminate` rather than being retried.
- **Scoped tool handles:** `tool.define` creates same-execution opaque handles with frozen captures and compiler-derived tool capabilities. Handles are never durable.
- **Agent-written commands and events:** `tools.command.define` turns a saved notebook function into a slash command, and `tools.event.define` runs one on an interval, a cron schedule, or once. Each run is its own execution whose outcome waits for the model's next step, merged with the same command's or event's earlier unseen outcomes; `tools.session.notify` wakes the model with fenced, attributed text.

This design is intentionally incompatible with the earlier Promise-oriented Code Mode runtime. See the single [Code Mode guide](packages/codemode/interpreter-support.md) for architecture diagrams, examples, lifecycle semantics, limits, and the full language contract.
