import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionEvent } from "@ocpp/schema/session-event"
import { Model, sessionEvent, sessionEventDefinitions, toOcppEventType } from "@specter/agent-runtime"
import { SpecterTranslate } from "../src/specter/translate"

// The Specter runtime is linked from a sibling checkout with its own node_modules. These checks
// fail when it loads a second Effect or diverges from OC++'s event catalog.
describe("embedded Specter runtime", () => {
  test("shares OC++'s Effect runtime", async () => {
    const model: Model["Service"] = {
      ref: { providerID: "test", id: "scripted" } as never,
      nextOutcome: () => Effect.die("unused"),
    }
    const read = Effect.gen(function* () {
      return yield* Model
    })
    expect(await Effect.runPromise(read.pipe(Effect.provide(Layer.succeed(Model, model))))).toBe(model)
  })

  test("defines OC++'s durable Session events under kebab-case names", () => {
    expect(sessionEventDefinitions.map((definition) => toOcppEventType(definition.type))).toEqual(
      expect.arrayContaining(SessionEvent.DurableDefinitions.map((definition) => definition.type)),
    )
  })

  test("projects its consolidated facts as OC++'s events", () => {
    const settled = (payload: Record<string, unknown>) =>
      SpecterTranslate.toWire({
        id: "evt_1",
        order: 1,
        type: "session-execution-settled",
        payload: { sessionID: "ses_1", ...payload },
        recordedAt: new Date(0).toISOString(),
      }).map((wire) => [wire.definition.type, wire.data, wire.id])
    expect(settled({ outcome: "succeeded" })).toEqual([["session.execution.succeeded", { sessionID: "ses_1" }, "evt_1"]])
    expect(settled({ outcome: "failed", error: { type: "provider", message: "boom" } })).toEqual([
      ["session.execution.failed", { sessionID: "ses_1", error: { type: "provider", message: "boom" } }, "evt_1"],
    ])
    expect(settled({ outcome: "interrupted", reason: "user" })).toEqual([
      ["session.execution.interrupted", { sessionID: "ses_1", reason: "user" }, "evt_1"],
    ])
    const step = (payload: Record<string, unknown>) =>
      SpecterTranslate.toWire({
        id: "evt_2",
        order: 2,
        type: "session-step-settled",
        payload: { sessionID: "ses_1", assistantMessageID: "msg_1", ...payload },
        recordedAt: new Date(0).toISOString(),
      }).map((wire) => [wire.definition.type, wire.data, wire.id])
    const tokens = { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } }
    const error = { type: "transport", message: "reset" }
    expect(step({ outcome: "succeeded", finish: "stop", cost: 0, tokens })).toEqual([
      [
        "session.step.ended",
        { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop", cost: 0, tokens },
        "evt_2",
      ],
    ])
    expect(step({ outcome: "failed", error })).toEqual([
      ["session.step.failed", { sessionID: "ses_1", assistantMessageID: "msg_1", error }, "evt_2"],
    ])
    expect(step({ outcome: "failed", error, retry: { attempt: 1, at: 5 } })).toEqual([
      ["session.step.failed", { sessionID: "ses_1", assistantMessageID: "msg_1", error }, "evt_2"],
      [
        "session.retry.scheduled",
        { sessionID: "ses_1", assistantMessageID: "msg_1", attempt: 1, at: 5, error },
        "evt_2_retry",
      ],
    ])
    const tool = (type: string, payload: Record<string, unknown>) =>
      SpecterTranslate.toWire({
        id: "evt_3",
        order: 3,
        type,
        payload: { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", ...payload },
        recordedAt: new Date(0).toISOString(),
      }).map((wire) => [wire.definition.type, wire.data, wire.id])
    const call = { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1" }
    expect(tool("session-tool-requested", { name: "execute", input: { code: "1" }, executed: false })).toEqual([
      ["session.tool.input.started", { ...call, name: "execute" }, "evt_3_input"],
      ["session.tool.input.ended", { ...call, text: '{"code":"1"}' }, "evt_3_text"],
      ["session.tool.called", { ...call, input: { code: "1" }, executed: false }, "evt_3"],
    ])
    const content = [{ type: "text", text: "2" }]
    expect(tool("session-tool-settled", { outcome: "succeeded", content, executed: true })).toEqual([
      ["session.tool.success", { ...call, content, executed: true }, "evt_3"],
    ])
    expect(tool("session-tool-settled", { outcome: "failed", error, executed: false })).toEqual([
      ["session.tool.failed", { ...call, error, executed: false }, "evt_3"],
    ])
  })

  test("validates payloads with OC++'s schemas", async () => {
    const enqueued = sessionEvent("session-inbox-enqueued")
    const valid = await enqueued.schema["~standard"].validate({
      sessionID: "ses_1",
      inboxID: "msg_1",
      item: { type: "user", payload: { text: "hi" }, delivery: "steer" },
    })
    expect("issues" in valid ? valid.issues : undefined).toBeUndefined()
    const invalid = await enqueued.schema["~standard"].validate({ sessionID: "nope", inboxID: "msg_1" })
    expect("issues" in invalid ? invalid.issues?.length : 0).toBeGreaterThan(0)
  })
})
