import { describe, expect, test } from "bun:test"
import { CodeMode, Tool, ToolHandle } from "@ocpp/codemode"
import { Effect, Schema } from "effect"
import { ExternalAgentGateway } from "../src/external-agent/gateway"
import { ExternalAgentBridge } from "../src/external-agent/bridge.node"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const object = {
  type: "object",
  properties: { count: { type: "number" } },
  required: ["count"],
  additionalProperties: false,
}
const definition = {
  name: "count",
  description: "Count rows",
  inputSchema: object,
  outputSchema: { type: "number" },
  capabilities: ["read"],
}

describe("external tool gateway", () => {
  test("validates input and output before crossing a delegated handle", async () => {
    const calls: unknown[] = []
    const handle = new ToolHandle(definition, (input) =>
      Effect.sync(() => {
        calls.push(input)
        return "invalid"
      }),
    )
    const gateway = await Effect.runPromise(ExternalAgentGateway.make({ tools: [handle] }))
    await expect(Effect.runPromise(gateway.invoke("count", { count: "wrong" }))).rejects.toThrow()
    expect(calls).toHaveLength(0)
    await expect(Effect.runPromise(gateway.invoke("count", { count: 1 }))).rejects.toThrow()
    expect(calls).toHaveLength(1)
    await expect(Effect.runPromise(gateway.invoke("missing", {}))).rejects.toThrow("Unknown external tool")
    handle.close()
    await expect(Effect.runPromise(gateway.invoke("count", { count: 2 }))).rejects.toThrow("no longer active")
  })

  test("keeps machine input, notebook declarations and submitted output out of model results", async () => {
    const secret = "private-dataset-token"
    const gateway = await Effect.runPromise(
      ExternalAgentGateway.make({
        input: { secret },
        inputSchema: { type: "object", required: ["secret"] },
        outputSchema: { type: "object", properties: { token: { type: "string" } }, required: ["token"] },
      }),
    )
    expect(JSON.stringify(gateway.definitions)).not.toContain(secret)
    const first = await Effect.runPromise(gateway.invoke("execute", { code: "const value = input.secret" }))
    expect(JSON.stringify(first)).not.toContain(secret)
    const second = await Effect.runPromise(
      gateway.invoke("execute", {
        code: 'const submitted = await tools.submit_result({ message: "done", output: { token: value } })',
      }),
    )
    expect(JSON.stringify(second)).not.toContain(secret)
    expect(gateway.result()).toEqual({ message: "done", output: { token: secret } })
    await expect(
      Effect.runPromise(gateway.invoke("submit_result", { message: "again", output: { token: "again" } })),
    ).rejects.toThrow("already submitted")
    gateway.close()
    await expect(Effect.runPromise(gateway.invoke("execute", { code: "input" }))).rejects.toThrow("closed")
  })

  test("rejects invalid input schemas, malformed handles and reserved names", async () => {
    await expect(
      Effect.runPromise(ExternalAgentGateway.make({ input: { count: "no" }, inputSchema: object })),
    ).rejects.toThrow()
    await expect(Effect.runPromise(ExternalAgentGateway.make({ tools: [{ definition }] }))).rejects.toThrow(
      "tool.define",
    )
    await expect(
      Effect.runPromise(
        ExternalAgentGateway.make({
          tools: [new ToolHandle({ ...definition, name: "execute" }, () => Effect.succeed(0))],
        }),
      ),
    ).rejects.toThrow("reserved")
  })

  test("compiler-derived capabilities and activation lifetime survive delegation", async () => {
    const calls: string[] = []
    const runtime = CodeMode.make({
      tools: {
        read: Tool.make({
          description: "read",
          input: Schema.Struct({}),
          output: Schema.String,
          execute: () =>
            Effect.sync(() => {
              calls.push("read")
              return "ok"
            }),
        }),
        delegate: Tool.make({
          description: "delegate",
          input: Schema.Struct({ tools: Schema.Array(Schema.Unknown) }),
          output: Schema.String,
          acceptsToolHandles: true,
          execute: (input) =>
            Effect.gen(function* () {
              const gateway = yield* ExternalAgentGateway.make({ tools: input.tools })
              const result = yield* gateway.invoke("read_once", {})
              expect(gateway.definitions.map((item) => item.name)).toEqual(["read_once", "execute"])
              gateway.close()
              return String(result)
            }),
        }),
      },
    })
    const result = await Effect.runPromise(
      runtime.execute(
        'let handle = tool.define({ name: "read_once", description: "Read", inputSchema: { type: "object" }, outputSchema: { type: "string" }, execute: () => tools.read({}) }); const result = await tools.delegate({ tools: [handle] }); result',
      ),
    )
    expect(result).toMatchObject({ ok: true })
    expect(calls).toEqual(["read"])
  })

  test("MCP bridge authenticates, validates and expires its real loopback transport", async () => {
    const gateway = await Effect.runPromise(
      ExternalAgentGateway.make({ tools: [new ToolHandle(definition, () => Effect.succeed(42))] }),
    )
    const controller = new AbortController()
    const bridge = await ExternalAgentBridge.open(gateway, controller.signal)
    const client = new Client({ name: "external-contract-test", version: "1" })
    try {
      expect((await fetch(bridge.url, { method: "POST", body: "{}" })).status).toBe(401)
      expect((await fetch(bridge.url, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401)
      await client.connect(
        new StreamableHTTPClientTransport(new URL(bridge.url), {
          requestInit: { headers: { Authorization: "Bearer " + bridge.token } },
        }),
      )
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["count", "execute"])
      expect((await client.callTool({ name: "count", arguments: { count: 1 } })).content).toEqual([
        { type: "text", text: "42" },
      ])
      expect((await client.callTool({ name: "count", arguments: { count: "bad" } })).isError).toBe(true)
      gateway.close()
      expect((await client.callTool({ name: "count", arguments: { count: 1 } })).isError).toBe(true)
    } finally {
      await client.close()
      await bridge.close()
    }
    await expect(fetch(bridge.url)).rejects.toThrow()
  })
})

test("non-object custom inputs remain available through execute without an invalid MCP schema", async () => {
  const handle = new ToolHandle(
    {
      name: "increment",
      description: "Increment a number",
      capabilities: [],
      inputSchema: { type: "number" },
      outputSchema: { type: "number" },
    },
    (value) => Effect.succeed(Schema.decodeUnknownSync(Schema.Number)(value) + 1),
  )
  const gateway = await Effect.runPromise(ExternalAgentGateway.make({ tools: [handle] }))
  expect(gateway.definitions.map((tool) => tool.name)).toEqual(["execute"])
  expect(gateway.definitions[0].description).toContain('inputSchema: {"type":"number"}')
  expect(await Effect.runPromise(gateway.invoke("execute", { code: "await tools.increment(4)" }))).toMatchObject({
    ok: true,
    value: 5,
  })
})

test("schema failures do not serialize private input values into model errors", async () => {
  const secret = "private-input-marker"
  const result = await Effect.runPromise(
    Effect.result(ExternalAgentGateway.make({ input: { count: secret }, inputSchema: object })),
  )
  expect(result._tag).toBe("Failure")
  if (result._tag === "Failure") {
    expect(String(result.failure)).toContain("does not match inputSchema")
    expect(String(result.failure)).not.toContain(secret)
  }
})
