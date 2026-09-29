import { describe, expect, test } from "bun:test"
import { resetSessionModel, restorePromptModel, syncPromptModel, syncSessionModel } from "./session-model-helpers"

const restore = (info: Parameters<typeof syncSessionModel>[1], metadata?: Record<string, unknown>) => {
  const calls: unknown[] = []
  syncSessionModel(
    {
      session: {
        restore(value) {
          calls.push(value)
        },
        reset() {},
      },
    },
    info,
    metadata,
  )
  return calls
}

describe("syncSessionModel", () => {
  test("restores the Session's model and agent", () => {
    expect(
      restore({
        id: "session",
        agent: "build",
        model: { id: "claude-sonnet-4", providerID: "anthropic", variant: "high" },
      }),
    ).toEqual([
      {
        sessionID: "session",
        agent: "build",
        model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" },
      },
    ])
  })

  test("restores the model of a Session that records no agent", () => {
    expect(restore({ id: "session", model: { id: "scripted", providerID: "demo", variant: "default" } })).toEqual([
      {
        sessionID: "session",
        agent: undefined,
        model: { providerID: "demo", modelID: "scripted", variant: "default" },
      },
    ])
    expect(restore({ id: "session", model: { id: "opus", providerID: "claude" } })).toEqual([
      { sessionID: "session", agent: undefined, model: { providerID: "claude", modelID: "opus", variant: undefined } },
    ])
  })

  test("waits for a model", () => {
    expect(restore(undefined, { agent: "build" })).toEqual([])
    expect(restore({ id: "session", agent: "build" })).toEqual([])
  })
})

describe("resetSessionModel", () => {
  test("clears draft session state", () => {
    const calls: string[] = []

    resetSessionModel({
      session: {
        reset() {
          calls.push("reset")
        },
        restore() {},
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
          set() {},
          variant: { current: () => "high", set() {} },
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
          set() {},
          variant: { current: () => model.variant, set() {} },
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

describe("restorePromptModel", () => {
  test("restores the persisted prompt model into session selection", () => {
    const calls: unknown[] = []
    const restored = restorePromptModel(
      {
        model: {
          current: () => ({ id: "gpt", provider: { id: "openai" } }),
          set: (model) => calls.push(model),
          variant: {
            current: () => undefined,
            set: (variant) => calls.push(variant),
          },
        },
      },
      {
        model: {
          current: () => ({ providerID: "anthropic", modelID: "claude", variant: "high" }),
          set() {},
        },
      },
    )

    expect(restored).toBe(true)
    expect(calls).toEqual([{ providerID: "anthropic", modelID: "claude" }, "high"])
  })

  test("does nothing without a persisted prompt model", () => {
    const calls: unknown[] = []
    const restored = restorePromptModel(
      {
        model: {
          current: () => ({ id: "gpt", provider: { id: "openai" } }),
          set: (model) => calls.push(model),
          variant: {
            current: () => undefined,
            set: (variant) => calls.push(variant),
          },
        },
      },
      {
        model: {
          current: () => undefined,
          set() {},
        },
      },
    )

    expect(restored).toBe(false)
    expect(calls).toEqual([])
  })
})
