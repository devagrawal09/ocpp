import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { Mcp } from "@ocpp/core/mcp/index"
import { McpInstructions } from "@ocpp/core/mcp/instructions"
import { McpTool } from "@ocpp/core/tool/mcp"
import { it } from "./lib/effect"
import { readInitial, readUpdate } from "./lib/instructions"

// The Code Mode paths a request's tool list holds.
const catalog = [McpTool.namespace("alpha") + ".search", McpTool.namespace("beta") + ".search", "read"]

const instructions = (server: string, text: string) =>
  new Mcp.ServerInstructions({ server: Mcp.ServerName.make(server), instructions: text })

const tool = (server: string, name = "search") => new Mcp.Tool({ server: Mcp.ServerName.make(server), name })

const layer = (servers: () => Mcp.ServerInstructions[], tools: () => Mcp.Tool[]) =>
  AppNodeBuilder.build(McpInstructions.node, [
    [
      Mcp.node,
      Layer.mock(Mcp.Service, {
        instructions: () => Effect.succeed(servers()),
        tools: () => Effect.succeed(tools()),
      }),
    ],
  ])

describe("McpInstructions", () => {
  it.effect("renders instructions for servers with at least one tool in the request's catalog", () =>
    Effect.gen(function* () {
      const service = yield* McpInstructions.Service
      // hidden has a tool, but not one this request's tool list holds.
      const generation = yield* service.load(catalog).pipe(Effect.flatMap(readInitial))

      expect(generation.text).toBe(
        [
          "<mcp_instructions>",
          '  <server name="alpha">',
          '    Use tools from this server through `execute` under `tools["alpha"]`.',
          "    Alpha line one",
          "    Alpha line two",
          "  </server>",
          '  <server name="beta">',
          '    Use tools from this server through `execute` under `tools["beta"]`.',
          "    Beta instructions",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }).pipe(
      Effect.provide(
        layer(
          () => [
            instructions("beta", "Beta instructions"),
            instructions("unused", "No tools"),
            instructions("hidden", "Unlisted tool"),
            instructions("alpha", "Alpha line one\nAlpha line two"),
          ],
          () => [tool("alpha"), tool("alpha", "restricted"), tool("beta"), tool("hidden")],
        ),
      ),
    ),
  )

  it.effect("renders additions, changes, and removal", () => {
    let servers = [instructions("alpha", "Alpha instructions")]
    const tools = [tool("alpha"), tool("beta")]
    return Effect.gen(function* () {
      const service = yield* McpInstructions.Service
      const initialized = yield* service.load(catalog).pipe(Effect.flatMap(readInitial))

      servers = [instructions("alpha", "Alpha instructions"), instructions("beta", "Beta instructions")]
      const added = yield* readUpdate(yield* service.load(catalog), initialized)
      expect(added.text).toBe(
        [
          "New MCP server instructions are available in addition to those previously listed:",
          '  <server name="beta">',
          '    Use tools from this server through `execute` under `tools["beta"]`.',
          "    Beta instructions",
          "  </server>",
        ].join("\n"),
      )

      servers = [instructions("alpha", "Updated alpha"), instructions("beta", "Beta instructions")]
      const changed = yield* readUpdate(yield* service.load(catalog), added)
      expect(changed.text).toBe(
        [
          "The available MCP server instructions have changed. This list supersedes the previous one.",
          "<mcp_instructions>",
          '  <server name="alpha">',
          '    Use tools from this server through `execute` under `tools["alpha"]`.',
          "    Updated alpha",
          "  </server>",
          '  <server name="beta">',
          '    Use tools from this server through `execute` under `tools["beta"]`.',
          "    Beta instructions",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )

      servers = [instructions("beta", "Beta instructions")]
      const removed = yield* readUpdate(yield* service.load(catalog), changed)
      expect(removed.text).toBe("Instructions for the following MCP servers are no longer available: alpha.")

      servers = []
      expect((yield* readUpdate(yield* service.load(catalog), removed)).text).toBe(
        "MCP server instructions are no longer available.",
      )
    }).pipe(
      Effect.provide(
        layer(
          () => servers,
          () => tools,
        ),
      ),
    )
  })
})
