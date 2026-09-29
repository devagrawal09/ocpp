import { describe, expect, test } from "bun:test"
import { composerModel } from "./composer-model"

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
