import { describe, expect, test } from "bun:test"
import { ExternalAgentModels } from "@ocpp/core/external-agent/models"

const model = (id: string, extra: Partial<ExternalAgentModels.Model> = {}): ExternalAgentModels.Model => ({
  id,
  listed: true,
  efforts: ["low", "medium", "high"],
  ...extra,
})

// Codex 0.160.0's catalog, in its own order.
const codex = [
  model("gpt-6.1-sol"),
  model("gpt-6-astra"),
  model("gpt-6-sol"),
  model("gpt-6-luna"),
  model("gpt-reserve", { listed: false }),
  model("gpt-5.6-sol"),
  model("gpt-5.6-terra"),
  model("gpt-5.6-luna"),
  model("gpt-5.5", {
    upgrade: { id: "gpt-6.1-sol", message: "GPT-5.5 retires on October 14, 2026." },
  }),
  model("codex-auto-review", { listed: false }),
]

describe("ExternalAgentModels", () => {
  test("each alias names its newest listed model", () => {
    expect(ExternalAgentModels.aliases(codex)).toEqual({
      sol: "gpt-6.1-sol",
      astra: "gpt-6-astra",
      luna: "gpt-6-luna",
      terra: "gpt-5.6-terra",
    })
  })

  test("versions compare numerically, and hidden models are no alias's newest", () => {
    expect(
      ExternalAgentModels.aliases([model("gpt-6.9-sol"), model("gpt-6.10-sol"), model("gpt-7-sol", { listed: false })]),
    ).toEqual({ sol: "gpt-6.10-sol" })
  })

  test("an alias resolves to its newest model and any other ID runs as given", () => {
    expect(ExternalAgentModels.resolve("sol", codex)).toBe("gpt-6.1-sol")
    expect(ExternalAgentModels.resolve("terra", codex)).toBe("gpt-5.6-terra")
    expect(ExternalAgentModels.resolve("gpt-5.6-sol", codex)).toBe("gpt-5.6-sol")
    expect(ExternalAgentModels.resolve("constructor", codex)).toBe("constructor")
    expect(ExternalAgentModels.resolve("sol", [])).toBe("sol")
  })

  test("a pinned model learns of its alias's newer model", () => {
    expect(ExternalAgentModels.newer("gpt-5.6-sol", codex)).toEqual({ id: "gpt-6.1-sol", alias: "sol" })
    expect(ExternalAgentModels.newer("gpt-6-sol", codex)).toEqual({ id: "gpt-6.1-sol", alias: "sol" })
    expect(ExternalAgentModels.newer("gpt-5.6-luna", codex)).toEqual({ id: "gpt-6-luna", alias: "luna" })
  })

  test("a retiring model learns of the vendor's named upgrade", () => {
    expect(ExternalAgentModels.newer("gpt-5.5", codex)).toEqual({
      id: "gpt-6.1-sol",
      alias: "sol",
      message: "GPT-5.5 retires on October 14, 2026.",
    })
  })

  test("aliases, newest and unknown models have nothing newer", () => {
    expect(ExternalAgentModels.newer("sol", codex)).toBeUndefined()
    expect(ExternalAgentModels.newer("gpt-6.1-sol", codex)).toBeUndefined()
    expect(ExternalAgentModels.newer("gpt-5.6-terra", codex)).toBeUndefined()
    expect(ExternalAgentModels.newer("gpt-7-sol", codex)).toBeUndefined()
    expect(ExternalAgentModels.newer("codex-auto-review", codex)).toBeUndefined()
  })
})
