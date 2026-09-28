import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Backend, Handshake, JsonRpc } from "../src/protocol"

const successResponse: Schema.Schema.Type<typeof JsonRpc.Response> = { jsonrpc: "2.0", id: 1, result: null }
// @ts-expect-error responses require one outcome
const missingResponse: Schema.Schema.Type<typeof JsonRpc.Response> = { jsonrpc: "2.0", id: 1 }
// @ts-expect-error responses cannot contain both outcomes
const invalidResponse: Schema.Schema.Type<typeof JsonRpc.Response> = {
  jsonrpc: "2.0",
  id: 1,
  result: null,
  error: { code: -32600, message: "Invalid request" },
}
void [successResponse, missingResponse, invalidResponse]

test("normalizes an omitted finish reason", () => {
  expect(Backend.decodeRequest({ jsonrpc: "2.0", id: 1, method: "llm.finish", params: { id: "inv_1" } })).toMatchObject(
    { params: { id: "inv_1", reason: "stop" } },
  )
})

test("decodes typed backend notifications", () => {
  expect(
    Backend.decodeNotification({
      jsonrpc: "2.0",
      method: "tool.cancel",
      params: { id: "tool_1", reason: "interrupted" },
    }),
  ).toEqual({
    jsonrpc: "2.0",
    method: "tool.cancel",
    params: { id: "tool_1", reason: "interrupted" },
  })
  expect(() =>
    Backend.decodeNotification({
      jsonrpc: "2.0",
      method: "tool.cancel",
      params: { id: "tool_1", reason: "unknown" },
    }),
  ).toThrow()
})

test("requires exactly one JSON-RPC response outcome", () => {
  const decode = Schema.decodeUnknownSync(JsonRpc.Response)
  expect(decode({ jsonrpc: "2.0", id: 1, result: null })).toEqual({ jsonrpc: "2.0", id: 1, result: null })
  expect(decode({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Invalid request" } })).toEqual({
    jsonrpc: "2.0",
    id: 1,
    error: { code: -32600, message: "Invalid request" },
  })
  expect(() => decode({ jsonrpc: "2.0", id: 1 })).toThrow()
  expect(() =>
    decode({
      jsonrpc: "2.0",
      id: 1,
      result: null,
      error: { code: -32600, message: "Invalid request" },
    }),
  ).toThrow()
})

test("decodes the simulated tool lifecycle", () => {
  const registration = {
    name: "lookup",
    description: "Look up a value",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
  }
  expect(
    Backend.decodeRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "tool.attach",
      params: { tools: [registration] },
    }),
  ).toMatchObject({ method: "tool.attach", params: { tools: [registration] } })
  expect(
    Backend.decodeRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tool.update",
      params: {
        id: "tool_1",
        sequence: 0,
        update: { phase: "searching" },
      },
    }),
  ).toMatchObject({ method: "tool.update" })
  expect(
    Backend.decodeRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tool.finish",
      params: {
        id: "tool_1",
        output: { structured: { answer: 42 }, content: [{ type: "text", text: "42" }] },
      },
    }),
  ).toMatchObject({ method: "tool.finish" })
  expect(
    Backend.decodeRequest({
      jsonrpc: "2.0",
      id: 4,
      method: "tool.fail",
      params: { id: "tool_2", message: "lookup failed" },
    }),
  ).toMatchObject({ method: "tool.fail" })
  expect(() =>
    Backend.decodeRequest({
      jsonrpc: "2.0",
      id: 5,
      method: "tool.attach",
      params: { tools: [registration, registration] },
    }),
  ).toThrow()
  for (const invalid of [
    { ...registration, name: "1lookup" },
    { ...registration, options: { namespace: "bad group" } },
    { ...registration, name: "search" },
    { ...registration, options: { namespace: "a".repeat(64) } },
  ])
    expect(() =>
      Backend.decodeRequest({
        jsonrpc: "2.0",
        id: 6,
        method: "tool.attach",
        params: { tools: [invalid] },
      }),
    ).toThrow()
  expect(() =>
    Backend.decodeRequest({
      jsonrpc: "2.0",
      id: 7,
      method: "tool.attach",
      params: {
        tools: [
          { ...registration, name: "b_c", options: { namespace: "a" } },
          { ...registration, name: "c", options: { namespace: "a.b" } },
        ],
      },
    }),
  ).toThrow()
})

const params: Handshake.Params = {
  client: { name: "ocpp-drive", version: "test" },
  expectedRole: "backend",
  offeredVersions: [1],
  requiredCapabilities: ["llm.attach"],
  optionalCapabilities: ["llm.pending", "future.capability"],
}

const backend: Handshake.DispatchAction = {
  role: "backend",
  server: { name: "ocpp", version: "test" },
  capabilities: Backend.Capabilities,
}

describe("simulation.handshake", () => {
  test("decodes through the backend request protocol", () => {
    const request = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "simulation.handshake" as const,
      params,
    }
    expect(Backend.decodeRequest(request)).toMatchObject({
      method: "simulation.handshake",
      params: { expectedRole: "backend" },
    })
  })

  test("rejects invalid version and capability declarations", () => {
    const request = {
      jsonrpc: "2.0" as const,
      id: 1,
      method: "simulation.handshake" as const,
      params,
    }
    expect(() =>
      Backend.decodeRequest({
        ...request,
        params: { ...params, offeredVersions: [] },
      }),
    ).toThrow()
    expect(() =>
      Backend.decodeRequest({
        ...request,
        params: { ...params, requiredCapabilities: ["llm.attach", "llm.attach"] },
      }),
    ).toThrow()
    expect(() =>
      Backend.decodeRequest({
        ...request,
        params: { ...params, optionalCapabilities: [""] },
      }),
    ).toThrow()
  })

  test("selects the protocol and advertises only installed capabilities", async () => {
    await expect(Effect.runPromise(Handshake.dispatch(backend, params))).resolves.toEqual({
      protocolVersion: 1,
      role: "backend",
      server: { name: "ocpp", version: "test" },
      capabilities: [...Backend.Capabilities],
    })
  })

  test("rejects a role mismatch", async () => {
    await expect(
      Effect.runPromise(Handshake.dispatch(backend, { ...params, expectedRole: "ui" })),
    ).rejects.toMatchObject({ _tag: "SimulationHandshake.RoleMismatchError", expected: "ui", actual: "backend" })
  })

  test("rejects unsupported protocol versions", async () => {
    await expect(
      Effect.runPromise(Handshake.dispatch(backend, { ...params, offeredVersions: [2] })),
    ).rejects.toMatchObject({
      _tag: "SimulationHandshake.UnsupportedProtocolError",
      offered: [2],
      supported: [1],
    })
  })

  test("rejects a missing required capability but ignores missing optional capabilities", async () => {
    await expect(
      Effect.runPromise(
        Handshake.dispatch(backend, {
          ...params,
          requiredCapabilities: ["llm.attach", "llm.future"],
        }),
      ),
    ).rejects.toMatchObject({ _tag: "SimulationHandshake.MissingCapabilityError", missing: ["llm.future"] })

    await expect(
      Effect.runPromise(
        Handshake.dispatch(backend, {
          ...params,
          requiredCapabilities: [],
          optionalCapabilities: ["llm.future"],
        }),
      ),
    ).resolves.toMatchObject({ capabilities: Backend.Capabilities })
  })
})
