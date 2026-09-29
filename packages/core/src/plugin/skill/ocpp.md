# OC++

Use this guide as the starting point for work involving OC++ itself. It
covers the core concepts needed to configure and customize OC++, extend it
with plugins, and build integrations with the OC++ SDK, clients, and API.

OC++ is forked from OpenCode and diverges from it; documentation written for
OpenCode does not describe OC++ behavior. This repository contains a heavily
modified V2 implementation, so do not assume it matches a published release or
any public website. When the active workspace is an OC++ checkout, resolve
questions against that checkout and the running local service before consulting
public documentation.

## Source policy

Choose the source of truth based on the question:

- For observed runtime behavior and the runtime API, inspect the elected local
  service with `ocpp service status`, `ocpp api`, its `/openapi.json`,
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

Use <https://ocpp.ai/v2/docs/> only as an upstream fallback when the relevant
local source is unavailable. Clearly label information taken only from upstream
and do not let it override this fork. Do not use general web search when the
checkout or running service can answer the question.

## Version policy

Always answer for OC++ V2 unless the user explicitly asks about V1,
legacy OC++, or migrating from V1.

Treat this checkout as the source of truth for its V2 behavior. Do not use
<https://ocpp.ai/docs/>, which documents V1. The schema served from
<https://ocpp.ai/config.json> may describe V1 even though V2 configuration
files include that URL for editor integration. Never use it to infer V2 field
names or shapes. If local documentation is missing or contradictory, inspect
the implementation and tests; state any remaining uncertainty instead of
falling back to V1 or assuming upstream behavior.

V1 documentation and syntax may be consulted only when the user explicitly
asks about V1 or when needed as migration input. Outputs and recommendations
must still use V2 unless the user specifically requests a V1 result.

## CLI

For questions about command-line invocation, `run`, or other CLI behavior,
read `packages/www/src/docs/content/cli/index.mdx` and the relevant local page.
Confirm behavior in `packages/cli/src/` when exact current behavior matters.

## OC++ configuration

OC++'s server and project configuration uses JSON or JSONC. Include the
published schema so the user's editor can validate fields and provide
autocomplete:

```jsonc
{
  "$schema": "https://ocpp.ai/config.json",
}
```

Global configuration lives at `~/.config/ocpp/ocpp.json(c)` and applies
to every project for that user. Project configuration can live in any directory
as `ocpp.json(c)` or `.ocpp/ocpp.json(c)`, including nested packages
in a monorepo.

During ordinary project discovery, OC++ searches the current Location
directory and every ancestor through the filesystem root, including directories
above the detected project or repository root. It merges direct
`ocpp.json(c)` files from the farthest ancestor to the current directory,
then does the same for `.ocpp/ocpp.json(c)` files. This means every
discovered `.ocpp` config overrides every discovered direct config. Global
filesystem configuration has lower precedence than these discovered documents.

Common configuration fields include `model`, `default_agent`, `agents`,
`commands`, `plugins`, `providers`, `mcp`, `skills`, `instructions`,
`references`, `formatter`, and `lsp`. Each agent's tools come from `init.ts`
beside the configuration (`.ocpp/init.ts` or `~/.config/ocpp/init.ts`), not
from a configuration field; read `packages/www/src/docs/content/tools.mdx`.

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
ocpp mcp add <name> --global --url <remote-url>
ocpp mcp list
```

Remote servers use OAuth by default. If `mcp list` reports that a server needs
authentication, run the OAuth flow and then verify the connection:

```sh
ocpp mcp auth <name>
ocpp mcp list
```

The auth command prints an authorization URL, waits for the browser redirect,
and stores credentials outside the OC++ configuration. Do not ask for or
store an API key when the server supports OAuth. Use header-based credentials
only when OAuth is unavailable or the user explicitly requires them, and use an
environment substitution such as `{env:MCP_API_KEY}` instead of writing a
secret into configuration.

## V1 to V2 migration

For any request to migrate OC++ configuration, agents, commands, skills,
plugins, integrations, or other behavior from V1 to V2, read
`packages/www/src/docs/content/migrate-v1.mdx` before acting.

V1 config files and `.ocpp/` definitions are intended to remain compatible.
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
in `packages/core/src/plugin.ts`.

## Service

OC++ uses a client-server architecture. Interfaces such as the web app
connect to a background OC++ service, which owns sessions, configuration,
plugins, and tool execution.

For the active service, prefer `ocpp service status`, `ocpp api`, and
the service log over assumptions from the worktree. Inspect
`packages/cli/src/services/` and `packages/server/src/` for implementation
details.

OC++ normally discovers or starts the shared background service
automatically. If the service is stuck or unhealthy, restart it:

```sh
ocpp service restart
```

Check its status after restarting:

```sh
ocpp service status
```

## API

OC++ exposes an HTTP API from its server. The API is described by an
OpenAPI document available from the running server at `/openapi.json`.

Use OC++'s built-in `api` command for local requests. It uses the same
discovery and authentication flow as the other `ocpp` commands and may start
the background service when no compatible healthy service is available. It
accepts either an HTTP method and path or an OpenAPI operation ID.

Call an endpoint with an HTTP method and path:

```sh
ocpp api get /api/health
```

Pass a request body with `--data` or `-d`, and additional headers with
`--header` or `-H`:

```sh
ocpp api post /api/example --data '{"key":"value"}'
ocpp api get /api/example --header 'X-Example:value'
```

Request bodies default to `Content-Type: application/json`. When OC++ is
connected to an explicit server instead of its managed background service, use
the same configured server and authentication context rather than constructing
an unauthenticated request separately.

For the running API, retrieve `/openapi.json` from that service. For the
worktree contract, inspect `packages/protocol/src/api.ts`,
`packages/protocol/src/groups/`, and `packages/protocol/openapi.json`. Handler
behavior lives in `packages/server/src/handlers/`.

## Client

For questions about connecting an application to OC++ over the network,
read `packages/www/src/docs/content/build/client/index.mdx`, then inspect
`packages/client/src/` for the generated surface in this checkout.

`@ocpp/client` is the generated TypeScript client for the OC++ HTTP
API. Its methods and types come from the same contract as the API reference.
The default entrypoint exposes Promise-based resource clients and async
iterables for streaming endpoints. The `@ocpp/client/effect` entrypoint
exposes typed Effects, Streams, and decoded OC++ schema values. Its
`Service` API can discover, start, stop, and authenticate with the local
background service from a Node application.

## Troubleshooting

OC++ runs a client and a background server. Start by determining whether a
problem belongs to the client, the shared server, or one project.

- Check the service with `ocpp service status` and verify the API with
  `ocpp api get /api/health`.
- Compare with `ocpp --standalone`, which serves the web app from a private
  server, to isolate shared-service issues.
- Inspect `~/.local/share/ocpp/log/ocpp.log`. Filter `role=cli` for
  client startup and `role=server` for sessions, providers, plugins, and
  tools.
- Run one reproduction with `OCPP_LOG_LEVEL=DEBUG` when normal logs are not
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
