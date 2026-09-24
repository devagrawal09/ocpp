export * as ExternalAgentBridge from "./bridge.node.js"

import { createServer } from "node:http"
import { randomBytes, timingSafeEqual } from "node:crypto"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { Effect } from "effect"
import type { ExternalAgentGateway } from "./gateway.js"

export function handlers(
  server: Pick<Server, "setRequestHandler">,
  gateway: ExternalAgentGateway.Gateway,
  signal: AbortSignal,
) {
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: gateway.definitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { ...tool.inputSchema, type: "object" as const },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await Effect.runPromise(
      Effect.result(gateway.invoke(request.params.name, request.params.arguments ?? {})),
      { signal },
    )
    if (result._tag === "Failure") return { isError: true, content: [{ type: "text", text: String(result.failure) }] }
    return {
      content: [
        {
          type: "text",
          text: typeof result.success === "string" ? result.success : (JSON.stringify(result.success) ?? "Completed."),
        },
      ],
    }
  })
}

/** A loopback, per-call MCP endpoint. The credential is passed as a header, never in a model prompt or URL. */
export async function open(gateway: ExternalAgentGateway.Gateway, signal: AbortSignal) {
  const token = randomBytes(32).toString("hex")
  const expected = Buffer.from("Bearer " + token)
  const transports = new Set<StreamableHTTPServerTransport>()
  const http = createServer((request, response) => {
    const received = Buffer.from(request.headers.authorization ?? "")
    if (
      request.url !== "/mcp" ||
      request.headers.origin ||
      received.length !== expected.length ||
      !timingSafeEqual(received, expected)
    ) {
      response.writeHead(401).end()
      return
    }
    const server = new Server({ name: "ocpp-external", version: "1" }, { capabilities: { tools: {} } })
    handlers(server, gateway, signal)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    transports.add(transport)
    response.on("close", () => {
      transports.delete(transport)
      void server.close()
    })
    void server
      .connect(transport)
      .then(() => transport.handleRequest(request, response))
      .catch(() => {
        if (!response.headersSent) response.writeHead(500)
        response.end()
      })
  })
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject)
    http.listen(0, "127.0.0.1", resolve)
  })
  const address = http.address()
  if (address === null || typeof address === "string") throw new Error("MCP bridge did not bind a TCP port")
  const close = async () => {
    await Promise.all([...transports].map((transport) => transport.close()))
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  }
  return { url: `http://127.0.0.1:${address.port}/mcp`, token, close }
}
