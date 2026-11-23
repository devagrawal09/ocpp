import { timingSafeEqual } from "node:crypto"
import { Ocpp } from "@ocpp/client"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { z } from "zod"

export function createMcpBridge(options: {
  baseUrl: string
  directory: string
  token: string
  sessions: Set<string>
  register: (sessionID: string) => Promise<void>
}) {
  if (options.token.length < 32) throw new Error("Bridge token must contain at least 32 characters")
  const client = Ocpp.make({ baseUrl: options.baseUrl })
  const secret = Buffer.from(`Bearer ${options.token}`)

  return async (request: Request) => {
    const authorization = Buffer.from(request.headers.get("authorization") ?? "")
    if (authorization.length !== secret.length || !timingSafeEqual(authorization, secret)) {
      return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": "Bearer" } })
    }
    // This bridge is for server-side agents, not browser-origin requests.
    if (request.headers.has("origin")) return new Response("Origin not allowed", { status: 403 })
    if (new URL(request.url).pathname !== "/mcp") return new Response("Not found", { status: 404 })
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } })

    // Each HTTP request gets a transport: MCP connection state is not task state.
    const server = new McpServer({ name: "ocpp-local-bridge", version: "0.1.0" })
    server.registerTool(
      "create_session",
      {
        description:
          "Create a local OC++ session in the bridge's fixed working directory. Save its ID for follow-up prompts and polling.",
        inputSchema: { title: z.string().max(200).optional() },
      },
      async ({ title }) => {
        const session = await client.session.create({ title, location: { directory: options.directory } })
        await options.register(session.id)
        options.sessions.add(session.id)
        return { content: [{ type: "text", text: JSON.stringify(session) }] }
      },
    )
    server.registerTool(
      "send_prompt",
      {
        description:
          "Submit a prompt to a bridge-created session. Returns durable admission immediately, not a completed answer. Poll get_session for results. Follow-ups steer active work.",
        inputSchema: { sessionID: z.string(), text: z.string().min(1).max(100_000) },
      },
      async ({ sessionID, text }) => {
        if (!options.sessions.has(sessionID)) throw new Error("Session is not owned by this bridge")
        const admission = await client.session.prompt({ sessionID, text })
        return { content: [{ type: "text", text: JSON.stringify(admission) }] }
      },
    )
    server.registerTool(
      "get_session",
      {
        description:
          "Read a bridge-created session, activity (null when idle), pending inbox, and a page of messages. Defaults to newest messages; use returned cursors for pagination. Agent work uses normal local OC++ permissions.",
        inputSchema: {
          sessionID: z.string(),
          limit: z.number().int().min(1).max(100).default(20),
          cursor: z.string().optional(),
        },
      },
      async ({ sessionID, limit, cursor }) => {
        if (!options.sessions.has(sessionID)) throw new Error("Session is not owned by this bridge")
        const [session, messages, inbox, active] = await Promise.all([
          client.session.get({ sessionID }),
          client.message.list({ sessionID, limit, order: "desc", cursor }),
          client.session.inbox.list({ sessionID }),
          client.session.active(),
        ])
        return {
          content: [
            { type: "text", text: JSON.stringify({ session, activity: active[sessionID] ?? null, messages, inbox }) },
          ],
        }
      },
    )
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
    await server.connect(transport)
    return transport.handleRequest(request).finally(() => server.close())
  }
}
