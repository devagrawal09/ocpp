import { describe, expect, test } from "bun:test"
import type { AgentListOutput, ModelListOutput, ProviderListOutput } from "@ocpp/client/promise"
import { configuredModel, directoryKey, normalizeAgentList, normalizeProviderList, withDrivers } from "./utils"

describe("normalizeAgentList", () => {
  test("adapts current agents to the app agent shape", () => {
    const result = normalizeAgentList([
      {
        id: "build",
        name: "Build",
        mode: "primary",
        hidden: false,
        color: "primary",
        model: { id: "gpt-5", providerID: "openai", variant: "high" },
        request: { settings: { temperature: 0.2, topP: 0.9 }, headers: {}, body: {} },
        system: "Build software",
      },
    ] as AgentListOutput["data"])

    expect(result).toEqual([
      {
        name: "build",
        description: undefined,
        mode: "primary",
        hidden: false,
        temperature: 0.2,
        topP: 0.9,
        color: "primary",
        model: { providerID: "openai", modelID: "gpt-5" },
        variant: "high",
        prompt: "Build software",
        options: { temperature: 0.2, topP: 0.9 },
        steps: undefined,
      },
    ])
  })
})

describe("normalizeProviderList", () => {
  test("groups current models into the app provider catalog", () => {
    const result = normalizeProviderList(
      [{ id: "openai", name: "OpenAI", package: "@ai-sdk/openai" }] as ProviderListOutput["data"],
      [
        {
          id: "gpt-5",
          modelID: "gpt-5",
          providerID: "openai",
          name: "GPT-5",
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          variants: [{ id: "high" }],
          time: { released: 1 },
          cost: [{ input: 1, output: 2, cache: { read: 0.1, write: 0.2 } }],
          status: "active",
          enabled: true,
          limit: { context: 128_000, output: 8_192 },
        },
        {
          id: "gpt-old",
          modelID: "gpt-old",
          providerID: "openai",
          name: "GPT Old",
          capabilities: { tools: false, input: ["text"], output: ["text"] },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "deprecated",
          enabled: true,
          limit: { context: 1, output: 1 },
        },
      ] as ModelListOutput["data"],
    )

    expect(result.connected).toEqual(["openai"])
    expect(result.default).toEqual({ openai: "gpt-5" })
    expect(result.all.get("openai")?.models["gpt-old"]).toBeUndefined()
    expect(result.all.get("openai")?.models["gpt-5"]).toMatchObject({
      id: "gpt-5",
      providerID: "openai",
      capabilities: { toolcall: true, attachment: true },
      cost: { input: 1, output: 2 },
      variants: { high: {} },
    })
  })

  test("leaves a config-defined model undated so the picker shows it", () => {
    const result = normalizeProviderList(
      [{ id: "demo", name: "Demo", package: "aisdk:@ai-sdk/openai-compatible" }] as ProviderListOutput["data"],
      [
        {
          id: "scripted",
          modelID: "scripted",
          providerID: "demo",
          name: "Scripted model",
          capabilities: { tools: true, input: ["text"], output: ["text"] },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: true,
          limit: { context: 200_000, output: 8_000 },
        },
      ] as ModelListOutput["data"],
    )

    expect(result.all.get("demo")?.models.scripted?.release_date).toBe("")
  })
})

describe("directoryKey", () => {
  test("normalizes slashes", () => {
    expect(String(directoryKey("C:\\Repos\\sst\\ocpp"))).toBe("C:/Repos/sst/ocpp")
    expect(String(directoryKey("C:/Repos/sst/ocpp"))).toBe("C:/Repos/sst/ocpp")
  })

  test("preserves backslashes in posix paths", () => {
    expect(String(directoryKey("/tmp/foo\\bar"))).toBe("/tmp/foo\\bar")
  })

  test("trims trailing slashes without breaking roots", () => {
    expect(String(directoryKey("C:/Repos/sst/ocpp/"))).toBe("C:/Repos/sst/ocpp")
    expect(String(directoryKey("C:/"))).toBe("C:/")
    expect(String(directoryKey("/"))).toBe("/")
  })
})

describe("withDrivers", () => {
  test("offers vendor drivers as providers and connects only the ready ones", () => {
    const catalog = { all: new Map(), connected: [], default: {} }
    const result = withDrivers(catalog, [
      {
        id: "claude",
        name: "Claude Code",
        available: true,
        model: "sonnet",
        models: ["sonnet", "opus"],
        variants: ["low", "high"],
      },
      { id: "codex", name: "Codex", available: false, model: "gpt-5.6-sol", models: ["gpt-5.6-sol"], variants: [] },
    ])
    expect(result.connected).toEqual(["claude"])
    expect(result.default).toEqual({ claude: "sonnet", codex: "gpt-5.6-sol" })
    expect(result.all.get("claude")?.name).toBe("Claude Code")
    expect(Object.keys(result.all.get("claude")?.models ?? {})).toEqual(["sonnet", "opus"])
    expect(result.all.get("claude")?.models.opus).toMatchObject({
      providerID: "claude",
      variants: { low: {}, high: {} },
    })
    expect(withDrivers(catalog, [])).toBe(catalog)
  })
})

describe("configuredModel", () => {
  test("reads the model from the highest-priority document that sets one", () => {
    expect(
      configuredModel([
        { type: "document", path: "/global/ocpp.json", info: { model: { providerID: "openai", model: "gpt-5" } } },
        { type: "document", path: "/project/ocpp.json", info: { model: { providerID: "demo", model: "scripted" } } },
        { type: "document", path: "/project/.ocpp/ocpp.json", info: { username: "dev" } },
        { type: "directory", path: "/project/.ocpp" },
      ]),
    ).toEqual({ providerID: "demo", modelID: "scripted" })
  })

  test("finds no model when no document sets one", () => {
    expect(
      configuredModel([
        { type: "document", info: {} },
        { type: "claude", path: "/home/.claude" },
      ]),
    ).toBeUndefined()
  })
})
