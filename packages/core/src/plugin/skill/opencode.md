# OpenCode

Use this guide as the starting point for work involving OpenCode itself. It
covers the core concepts needed to configure and customize OpenCode, extend it
with plugins, and build integrations with the OpenCode SDK, clients, and API.

This repository contains a heavily modified OpenCode V2 implementation. Do not
assume it matches a published release or the upstream website. When the active
workspace is an OpenCode checkout, resolve questions against that checkout and
the running local service before consulting public documentation.

## Source policy

Choose the source of truth based on the question:

- For observed runtime behavior and the runtime API, inspect the elected local
  service with `opencode2 service status`, `opencode2 api`, its `/openapi.json`,
  and its logs. The running binary may differ from the current worktree.
- For implementation behavior, inspect the current checkout's source and tests.
  Do not infer behavior from package versions, released clients, or upstream
  code.
- For API shape, use `packages/protocol/src/api.ts`,
  `packages/protocol/src/groups/`, and `packages/protocol/openapi.json`; use
  `packages/server/src/handlers/` for server behavior. Generated client code is
  downstream of this contract.
- For configuration shape, use `packages/schema/src/config.ts`, the modules in
  `packages/schema/src/config/`, the loader in `packages/core/src/config.ts`,
  and its supporting modules in `packages/core/src/config/`.
- For architecture and intended V2 invariants, read `AGENTS.md`, the nearest
  package `AGENTS.md`, and `specs/v2/`.
- For explanatory documentation, read the local sources in
  `packages/www/src/docs/content/`. They may lag implementation, so resolve any
  conflict in favor of code, tests, generated contracts, and observed runtime
  behavior.

Use <https://opencode.ai/v2/docs/> only as an upstream fallback when the relevant
local source is unavailable. Clearly label information taken only from upstream
and do not let it override this fork. Do not use general web search when the
checkout or running service can answer the question.

## Version policy

Always answer for OpenCode V2 unless the user explicitly asks about V1,
legacy OpenCode, or migrating from V1.

Treat this checkout as the source of truth for its V2 behavior. Do not use
<https://opencode.ai/docs/>, which documents V1. The schema served from
<https://opencode.ai/config.json> may describe V1 even though V2 configuration
files include that URL for editor integration. Never use it to infer V2 field
names or shapes. If local documentation is missing or contradictory, inspect
the implementation and tests; state any remaining uncertainty instead of
falling back to V1 or assuming upstream behavior.

V1 documentation and syntax may be consulted only when the user explicitly
asks about V1 or when needed as migration input. Outputs and recommendations
must still use V2 unless the user specifically requests a V1 result.

## CLI

For questions about the terminal interface, command-line invocation, `run`,
`mini`, terminal providers, or other CLI behavior, read
`packages/www/src/docs/content/cli/index.mdx` and the relevant local page.
Confirm behavior in `packages/cli/src/` or `packages/tui/src/` when exact current
behavior matters.

CLI and TUI preferences are separate from OpenCode's server and project
configuration. They live in the global `~/.config/opencode/cli.json`, or
`$XDG_CONFIG_HOME/opencode/cli.json` when `XDG_CONFIG_HOME` is set. There is no
project-local CLI configuration. Most preferences can also be changed from the
TUI by pressing `Ctrl+P` and selecting **Open settings**.

Read `packages/www/src/docs/content/cli/config.mdx` before editing `cli.json`. It
covers terminal-only settings such as themes, keybindings, terminal plugins,
scrolling, attention alerts, diff presentation, and terminal integration.
Confirm accepted fields in `packages/cli/src/config/`. Do not put these settings
in `opencode.json(c)`.

### Keybinds

Configure keybindings under `keybinds` in `cli.json`. The leader key is the
`keybinds.leader` entry; leader timing is configured separately under
`leader.timeout`. Bindings can use a string, an array of strings, or an object
when event behavior such as `preventDefault` is required. Disable a binding
with `"none"` or `false`.

Never guess a command ID, default binding, or accepted key syntax. Read
`packages/www/src/docs/content/cli/keybinds.mdx`, then confirm current IDs and
defaults in the CLI and TUI source before answering or editing a binding.

## OpenCode configuration

OpenCode's server and project configuration uses JSON or JSONC. Include the
published schema so the user's editor can validate fields and provide
autocomplete:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
}
```

Global configuration lives at `~/.config/opencode/opencode.json(c)` and applies
to every project for that user. Project configuration can live in any directory
as `opencode.json(c)` or `.opencode/opencode.json(c)`, including nested packages
in a monorepo.

During ordinary project discovery, OpenCode searches the current Location
directory and every ancestor through the filesystem root, including directories
above the detected project or repository root. It merges direct
`opencode.json(c)` files from the farthest ancestor to the current directory,
then does the same for `.opencode/opencode.json(c)` files. This means every
discovered `.opencode` config overrides every discovered direct config. Global
filesystem configuration has lower precedence than these discovered documents.

Common configuration fields include `model`, `default_agent`, `permissions`,
`agents`, `commands`, `plugins`, `providers`, `mcp`, `skills`, `instructions`,
`references`, `formatter`, and `lsp`.

This configuration is distinct from `cli.json`. Use the
local `packages/www/src/docs/content/cli/config.mdx` guide for terminal
preferences, especially themes and keybindings.

Do not guess field names or shapes. Read
`packages/www/src/docs/content/config.mdx` and its linked local topic guide,
then confirm shapes in `packages/schema/src/config.ts` and
`packages/schema/src/config/`. Preserve unrelated settings when editing an
existing file. Keep the published `$schema` URL in configuration examples, but
do not fetch it to determine the V2 configuration shape.

The local configuration guide contains field examples, config locations, and
links to dedicated feature guides.

## MCP servers

Read `packages/www/src/docs/content/mcp-servers.mdx` for setup guidance. Confirm
the current configuration and behavior in `packages/schema/src/config/mcp.ts`,
`packages/core/src/config/plugin/mcp.ts`, and the relevant tests.

Configure MCP servers under `mcp.servers`. Prefer the CLI because it preserves
unrelated configuration. Use `--global` when the user asks to set up a service
for themselves without limiting it to the current project; omit it when they
explicitly want project-local configuration.

```sh
opencode2 mcp add <name> --global --url <remote-url>
opencode2 mcp list
```

Remote servers use OAuth by default. If `mcp list` reports that a server needs
authentication, run the OAuth flow and then verify the connection:

```sh
opencode2 mcp auth <name>
opencode2 mcp list
```

The auth command prints an authorization URL, waits for the browser redirect,
and stores credentials outside the OpenCode configuration. Do not ask for or
store an API key when the server supports OAuth. Use header-based credentials
only when OAuth is unavailable or the user explicitly requires them, and use an
environment substitution such as `{env:MCP_API_KEY}` instead of writing a
secret into configuration.

## V1 to V2 migration

For any request to migrate OpenCode configuration, agents, commands, skills,
plugins, integrations, or other behavior from V1 to V2, read
`packages/www/src/docs/content/migrate-v1.mdx` before acting.

V1 config files and `.opencode/` definitions are intended to remain compatible.
The only intentional breaking changes are the server API and plugin API. Native
V2 config uses more ergonomic shapes, but conversion is optional. When the user
requests conversion, inspect the complete configuration, preserve behavior and
unrelated settings, and apply only the relevant migrations from the guide. For
plugin migrations, follow both the migration guide and
`packages/www/src/docs/content/build/plugins/index.mdx`. If non-API V1
functionality fails in V2, confirm the failure against this checkout before
using the `report` skill to file it as a compatibility bug.

## Plugins

For questions about creating, configuring, loading, publishing, or migrating
plugins, read `packages/www/src/docs/content/build/plugins/index.mdx` before
answering. Confirm current APIs in `packages/plugin/src/` and loading behavior
in `packages/core/src/plugin.ts`. Plugins can also extend the TUI; for those,
read `packages/www/src/docs/content/build/plugins/cli.mdx` and inspect
`packages/plugin/src/tui/`.

## Service

OpenCode uses a client-server architecture. Interfaces such as the TUI connect
to a background OpenCode service, which owns sessions, configuration, plugins,
permissions, and tool execution.

For the active service, prefer `opencode2 service status`, `opencode2 api`, and
the service log over assumptions from the worktree. Inspect
`packages/cli/src/services/` and `packages/server/src/` for implementation
details.

OpenCode normally discovers or starts the shared background service
automatically. If the service is stuck or unhealthy, restart it:

```sh
opencode2 service restart
```

Check its status after restarting:

```sh
opencode2 service status
```

## API

OpenCode exposes an HTTP API from its server. The API is described by an
OpenAPI document available from the running server at `/openapi.json`.

Use OpenCode's built-in `api` command for local requests. It uses the same
discovery and authentication flow as the TUI and may start the background
service when no compatible healthy service is available. It accepts either an
HTTP method and path or an OpenAPI operation ID.

Call an endpoint with an HTTP method and path:

```sh
opencode2 api get /api/health
```

Pass a request body with `--data` or `-d`, and additional headers with
`--header` or `-H`:

```sh
opencode2 api post /api/example --data '{"key":"value"}'
opencode2 api get /api/example --header 'X-Example:value'
```

Request bodies default to `Content-Type: application/json`. When OpenCode is
connected to an explicit server instead of its managed background service, use
the same configured server and authentication context rather than constructing
an unauthenticated request separately.

For the running API, retrieve `/openapi.json` from that service. For the
worktree contract, inspect `packages/protocol/src/api.ts`,
`packages/protocol/src/groups/`, and `packages/protocol/openapi.json`. Handler
behavior lives in `packages/server/src/handlers/`.

## Client

For questions about connecting an application to OpenCode over the network,
read `packages/www/src/docs/content/build/client/index.mdx`, then inspect
`packages/client/src/` for the generated surface in this checkout.

`@opencode-ai/client` is the generated TypeScript client for the OpenCode HTTP
API. Its methods and types come from the same contract as the API reference.
The default entrypoint exposes Promise-based resource clients and async
iterables for streaming endpoints. The `@opencode-ai/client/effect` entrypoint
exposes typed Effects, Streams, and decoded OpenCode schema values. Its
`Service` API can discover, start, stop, and authenticate with the local
background service from a Node application.

## Troubleshooting

OpenCode runs a client and a background server. Start by determining whether a
problem belongs to the client, the shared server, or one project.

- Check the service with `opencode2 service status` and verify the API with
  `opencode2 api get /api/health`.
- Compare with `opencode2 --standalone`, which runs the TUI with a private
  server, to isolate shared-service issues.
- Inspect `~/.local/share/opencode/log/opencode.log`. Filter `role=cli` for
  client startup and `role=server` for sessions, providers, plugins,
  permissions, and tools.
- Run one reproduction with `OPENCODE_LOG_LEVEL=DEBUG` when normal logs are not
  sufficient.
- Do not delete or edit the database, service registration, or service config
  while diagnosing a problem. Back up persistent data before inspecting it
  with external tools.
- Redact API keys, authorization headers, prompts, file contents, and other
  sensitive data before sharing diagnostics.

Read `packages/www/src/docs/content/troubleshooting.mdx` for service lifecycle
commands, API inspection, log locations, explicit server connections,
issue-reporting details, and local development paths. Confirm all commands and
paths against this checkout and the running service.
