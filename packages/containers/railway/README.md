# OC++ on Railway

One Docker service runs a supervised OC++ server, userspace Tailscale, and a
small public Basic Auth recovery dashboard. Only the dashboard port is public.
OC++ binds to `127.0.0.1:4096`; Tailscale Serve exposes it privately over HTTPS.
The image bundles the production web UI alongside the API. Open the private
Tailscale URL to use the web app directly; it connects to the same server
automatically. The public Railway URL serves only the recovery dashboard.

## Deployment

Deploy from a repository-root build context. Configure the service's Dockerfile
path as `packages/containers/railway/Dockerfile`, its health check as `/health`,
and its restart policy as `Always` using Railway service settings or the CLI.
Attach one volume at `/data` before the first runtime starts.
Set `CONTROL_USERNAME` (default `admin`) and a random `CONTROL_PASSWORD` of at
least 20 characters. Set Railway's public domain target port to `8080`. Keep
one replica and service sleeping disabled. `/health` is a minimal public
platform health check; all dashboard and management routes require Basic Auth.

Railway no longer permits new services to opt into legacy `railway.json` or
`railway.toml` configuration. Use `.railway/railway.ts` if infrastructure needs
to be managed in source control; this deployment uses service configuration.

Log in to Tailscale using the dashboard's enrollment link, or provide a
`TS_AUTHKEY` Railway secret. Enable tailnet HTTPS certificates when prompted
by Tailscale Serve. Do not enable Funnel. Tailnet policy must permit your
computer to reach this node on port 443. The dashboard displays its private URL.

Use `railway ssh` for administration. Codex and Claude Code are installed in the
image. Run `codex login --device-auth` for eligible ChatGPT subscription access.
Claude Code login does not establish that subscription usage through OC++'s
Agent SDK integration is authorized; follow Anthropic's current SDK billing
and authentication requirements.

## Storage and recovery

Home, XDG paths, vendor login state, OC++ configuration/database, repositories,
and Tailscale node state live under `/data`. Repositories belong in
`/data/workspaces`; use separate clones or worktrees for concurrent tasks.
Do not store persistent work outside the volume. Protect and back up the volume.

The dashboard restarts only OC++, after a graceful shutdown with a 20-second
deadline. Active work and terminals may be interrupted. Both OC++ and
Tailscale are automatically restarted after process exit. Railway's restart
policy recovers a failed container; the Railway dashboard remains the fallback
when the entire container is unavailable. No credentials, arbitrary commands,
raw logs, or public OC++ proxy are exposed by the control dashboard.

## Validation

From this directory, run `bun install`, `bun typecheck`, and `bun test`.
The tests exercise Basic Auth, status, real subprocess restart, and CSRF checks.
