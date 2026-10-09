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
