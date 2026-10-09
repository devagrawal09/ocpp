import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionEvent } from "@ocpp/schema/session-event"
import { Model, sessionEvent, sessionEventDefinitions, toOcppEventType } from "@specter/agent-runtime"

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
      SessionEvent.DurableDefinitions.map((definition) => definition.type),
    )
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
