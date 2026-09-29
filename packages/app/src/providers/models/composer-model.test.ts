import { describe, expect, test } from "bun:test"
import { referencedModel } from "@/runtime/server/global-sync/utils"
import type { Provider } from "@/runtime/server/types"
import { composerModel, describeModel } from "./composer-model"

const scripted = { providerID: "demo", modelID: "scripted" }
const opus = { providerID: "claude", modelID: "opus" }
const gpt = { providerID: "opencode", modelID: "gpt-5.5" }
const sonnet = { providerID: "anthropic", modelID: "claude-sonnet-4" }
const available =
  (...models: Array<{ providerID: string; modelID: string }>) =>
  (model: typeof scripted) =>
    models.some((item) => item.providerID === model.providerID && item.modelID === model.modelID)

describe("composerModel", () => {
  test("prefers the most recent pick over the config model", () => {
    expect(
      composerModel({ recent: [opus], configured: scripted, first: gpt, available: available(opus, scripted, gpt) }),
    ).toEqual(opus)
  })

  test("starts on the config model when nothing was picked", () => {
    expect(
      composerModel({ recent: [], configured: scripted, first: gpt, available: available(scripted, gpt) }),
    ).toEqual(scripted)
  })

  test("skips a recent pick that is no longer available", () => {
    expect(
      composerModel({ recent: [opus, sonnet], configured: scripted, available: available(sonnet, scripted) }),
    ).toEqual(sonnet)
    expect(composerModel({ recent: [opus], configured: scripted, available: available(scripted) })).toEqual(scripted)
  })

  test("keeps the composer's own pick, then its agent's model, ahead of recent picks", () => {
    const models = available(opus, scripted, gpt, sonnet)
    expect(
      composerModel({ pick: gpt, agent: sonnet, recent: [opus], configured: scripted, available: models }),
    ).toEqual(gpt)
    expect(composerModel({ agent: sonnet, recent: [opus], configured: scripted, available: models })).toEqual(sonnet)
  })

  test("falls back to the first connected model", () => {
    expect(composerModel({ recent: [], configured: scripted, first: gpt, available: available(gpt) })).toEqual(gpt)
    expect(composerModel({ recent: [], available: available() })).toBeUndefined()
  })
})

describe("composerModel for an existing Session", () => {
  const unlisted = { providerID: "claude", modelID: "claude-opus-4-7" }

  test("keeps the Session's own model when the picker does not offer it", () => {
    expect(
      composerModel({ session: unlisted, recent: [opus], configured: scripted, available: available(opus, scripted) }),
    ).toEqual(unlisted)
  })

  test("starts a Session without a model like a draft", () => {
    expect(composerModel({ recent: [opus], configured: scripted, available: available(opus, scripted) })).toEqual(opus)
  })
})

describe("describeModel", () => {
  const efforts = { low: {}, high: {}, max: {} }
  const claude: Provider = {
    id: "claude",
    name: "Claude Code",
    source: "custom",
    env: [],
    options: {},
    models: { opus: { ...referencedModel("claude", "opus", []), variants: efforts } },
  }

  test("names a driver model outside the driver's suggestions and keeps the driver's efforts", () => {
    const model = describeModel({ providerID: "claude", modelID: "claude-opus-4-7", variant: "high" }, claude)
    expect(model).toMatchObject({ id: "claude-opus-4-7", name: "claude-opus-4-7 (Claude Code)", provider: claude })
    expect(Object.keys(model.variants ?? {})).toEqual(["low", "high", "max"])
  })

  test("names a model of a driver that is not ready from its catalog entry", () => {
    const codex = {
      ...claude,
      id: "codex",
      name: "Codex",
      models: { "gpt-5.6-terra": referencedModel("codex", "gpt-5.6-terra", ["high"]) },
    }
    expect(describeModel({ providerID: "codex", modelID: "gpt-5.6-terra" }, codex)).toMatchObject({
      id: "gpt-5.6-terra",
      name: "gpt-5.6-terra",
      provider: { id: "codex", name: "Codex" },
    })
  })

  test("names a driver model before the driver list arrives and keeps the Session's effort", () => {
    const model = describeModel({ providerID: "claude", modelID: "opus", variant: "max" }, undefined)
    expect(model).toMatchObject({
      id: "opus",
      name: "opus (Claude Code)",
      provider: { id: "claude", name: "Claude Code" },
    })
    expect(Object.keys(model.variants ?? {})).toEqual(["max"])
    expect(
      Object.keys(
        describeModel({ providerID: "claude", modelID: "opus", variant: "default" }, undefined).variants ?? {},
      ),
    ).toEqual([])
  })

  test("names a model whose provider is gone by its full reference", () => {
    expect(describeModel({ providerID: "gone", modelID: "model" }, undefined)).toMatchObject({
      name: "gone/model",
      provider: { id: "gone", name: "gone" },
    })
  })
})
