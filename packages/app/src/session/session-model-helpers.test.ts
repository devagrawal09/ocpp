import { describe, expect, test } from "bun:test"
import { resetSessionModel, syncPromptModel } from "./session-model-helpers"

describe("resetSessionModel", () => {
  test("clears draft session state", () => {
    const calls: string[] = []

    resetSessionModel({
      session: {
        reset() {
          calls.push("reset")
        },
      },
    })

    expect(calls).toEqual(["reset"])
  })
})

describe("syncPromptModel", () => {
  test("stores the effective session model in prompt state", () => {
    const calls: unknown[] = []

    syncPromptModel(
      {
        model: {
          current: () => ({ id: "claude-sonnet-4", provider: { id: "anthropic" } }),
          variant: { current: () => "high" },
        },
      },
      {
        model: {
          current: () => undefined,
          set: (model) => calls.push(model),
        },
      },
    )

    expect(calls).toEqual([{ providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" }])
  })

  test("does not rewrite an unchanged prompt model", () => {
    const calls: unknown[] = []
    const model = { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" }

    syncPromptModel(
      {
        model: {
          current: () => ({ id: model.modelID, provider: { id: model.providerID } }),
          variant: { current: () => model.variant },
        },
      },
      {
        model: {
          current: () => model,
          set: (value) => calls.push(value),
        },
      },
    )

    expect(calls).toEqual([])
  })
})
