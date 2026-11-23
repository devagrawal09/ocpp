# Local MCP Bridge

A small Streamable HTTP MCP endpoint for trusted cloud agents. It exposes only
`create_session`, `send_prompt`, and `get_session`, and accepts a bearer key.
It is not an OAuth server; the remote MCP client must support custom headers.

## Start

From the checkout root:

```sh
OCPP_URL=$(bun --conditions=browser packages/cli/src/index.ts service status) \
  bun packages/cli/script/mcp-bridge.ts
```

The bridge binds to `127.0.0.1:49376/mcp`. New sessions use the current directory.
Optional environment variables are `OCPP_BRIDGE_DIRECTORY`, `OCPP_BRIDGE_PORT`,
and `OCPP_BRIDGE_STATE`. The default state directory is
`~/.local/share/ocpp/mcp-bridge`, containing a private `key` and a durable
`sessions` allowlist. Restarting preserves both. The local service URL can change
after restarting OC++; rediscover it before restarting the bridge.

Expose the bridge, never the full OC++ service, with a temporary tunnel:

```sh
~/.local/share/ocpp/mcp-bridge/cloudflared tunnel \
  --url http://127.0.0.1:49376 --no-autoupdate --protocol http2
```

The setup installed `cloudflared` at that path. Its output contains a public
HTTPS URL. Append `/mcp` and configure the remote client with:

```json
{
  "mcpServers": {
    "ocpp-local": {
      "url": "https://YOUR-TUNNEL.trycloudflare.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_KEY" }
    }
  }
}
```

## Task Flow

1. Call `create_session` with an optional `title` and retain the returned `id`.
2. Call `send_prompt` with `sessionID` and `text`. The response confirms durable admission, not completion.
3. Poll `get_session` with `sessionID`. It returns session info, activity, pending inbox, and paginated messages. An empty inbox alone does not mean execution has completed.
4. Use the same session ID for follow-ups. All key holders share access to all bridge-created sessions.

## Security And Lifetime

- The key authorizes local agent work, potentially including shell commands, file access, credentials, network requests, and model costs under normal OC++ permissions. This is not a filesystem sandbox.
- Existing local sessions are rejected by the MCP tools, but that API restriction does not sandbox what an authorized agent can do through its normal tools.
- Only server-side clients are supported; requests with browser `Origin` headers are rejected.
- Keep the key and generated `client.json` out of git and share them only with trusted agents.
- Stop the tunnel to remove public access. Stop the bridge as well when not needed. Neither process is installed as an auto-start service.
- The temporary URL changes when the tunnel restarts and is unavailable while the machine sleeps or is offline.
- To revoke the key, stop the bridge, remove its `key` file, restart it, and update client credentials. Session ownership persists independently in `sessions`.
