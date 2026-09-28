export * as McpTool from "./mcp.js"

import { ToolFailure } from "@ocpp/ai"
import { McpEvent } from "@ocpp/schema/mcp-event"
import { Context, Effect, Fiber, type JsonSchema, Layer, Semaphore, Stream } from "effect"
import { makeLocationNode } from "@ocpp/util/effect/app-node"
import { Bus } from "../bus.js"

import { Mcp } from "../mcp/index.js"
import { Tool } from "../tool.js"

/**
 * Registry namespace and effective names for MCP tools.
 */
export const namespace = (server: string) => server.replace(/[^a-zA-Z0-9_-]/g, "_")
export const name = (server: string, tool: string) => `${namespace(server)}_${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`

export interface Interface {
  /** Wait for the initial MCP tool registration to settle. */
  readonly flush: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/McpTool") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const tools = yield* Tool.Service
    const bus = yield* Bus.Service
    const lock = Semaphore.makeUnsafe(1)
    let discovered: Mcp.Tool[] = []

    // Register once after initial discovery; only subsequent updates need a debounced reload.
    const initial = yield* lock
      .withPermit(
        Effect.gen(function* () {
          discovered = yield* mcp.tools()
          yield* tools.transform((draft) => {
            for (const tool of discovered) {
              const schema = (tool.inputSchema ?? {}) as JsonSchema.JsonSchema
              draft.add({
                name: tool.name,
                options: { namespace: namespace(tool.server) },
                description: tool.description ?? "",
                input: {
                  ...schema,
                  type: "object",
                  properties: schema.properties ?? {},
                  additionalProperties: false,
                },
                output: (tool.outputSchema ?? {}) as JsonSchema.JsonSchema,
                execute: (input, context) =>
                  Effect.gen(function* () {
                    const result = yield* mcp
                      .callTool({
                        server: tool.server,
                        name: tool.name,
                        args: (input ?? {}) as Record<string, unknown>,
                        sessionID: context.sessionID,
                      })
                      .pipe(
                        Effect.catchTags({
                          "MCP.NotFoundError": (error) =>
                            new ToolFailure({ message: `MCP server "${error.server}" is not available` }),
                          "MCP.ToolCallError": (error) => new ToolFailure({ message: error.message }),
                        }),
                      )
                    if (result.isError)
                      return yield* new ToolFailure({
                        message:
                          result.content
                            .flatMap((part) => (part.type === "text" ? [part.text] : []))
                            .join("\n")
                            .trim() || "MCP tool returned an error",
                      })
                    const content = result.content.map((part) =>
                      part.type === "text"
                        ? { type: "text" as const, text: part.text }
                        : {
                            type: "file" as const,
                            uri: `data:${part.mimeType};base64,${part.data}`,
                            mime: part.mimeType,
                          },
                    )
                    const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
                    return {
                      output: result.structured ?? (text === "" ? null : text),
                      ...(content.length === 0 ? {} : { content }),
                    }
                  }).pipe(
                    Effect.mapError((error) =>
                      error instanceof ToolFailure
                        ? error
                        : new ToolFailure({ message: `Unable to execute ${name(tool.server, tool.name)}` }),
                    ),
                  ),
              })
            }
          })
        }),
      )
      .pipe(Effect.forkScoped)
    const reconcile = lock.withPermit(
      Effect.gen(function* () {
        discovered = yield* mcp.tools()
        yield* tools.reload()
      }),
    )

    yield* bus.subscribe(McpEvent.ToolsChanged).pipe(
      // Each read loads the whole catalog, so queued notifications need only one refresh.
      Stream.runForEachArray(() => reconcile),
      Effect.forkScoped({ startImmediately: true }),
    )
    return Service.of({ flush: Effect.asVoid(Fiber.await(initial)) })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Tool.node, Mcp.node, Bus.node],
})
