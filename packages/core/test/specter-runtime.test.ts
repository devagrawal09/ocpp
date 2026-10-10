import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Effect } from "effect"
import { DurableEventManifest } from "@ocpp/schema/durable-event-manifest"
import { ExternalSession } from "@ocpp/schema/external-session"
import { SessionEvent } from "@ocpp/schema/session-event"
import { sessionEvent, sessionEventDefinitions } from "@ocpp/session-runtime"

// The session runtime links Specter's packages from a Specter checkout with its own node_modules.
// These checks fail when the process loads a second Effect or the runtime diverges from OC++'s
// event catalog.
describe("embedded Specter runtime", () => {
  test("shares OC++'s Effect runtime", async () => {
    // The effect module Specter's core resolves is OC++'s own, through the session runtime's preload.
    const runtime = path.dirname(Bun.resolveSync("@ocpp/session-runtime", import.meta.dir))
    const specter = path.dirname(fs.realpathSync(Bun.resolveSync("@specter-ts/core", runtime)))
    const loaded = await import(Bun.resolveSync("effect", specter))
    expect(loaded.Effect).toBe(Effect)
  })

  test("defines every fact OC++ records under its own name, once", () => {
    expect(sessionEventDefinitions.map((definition) => definition.type)).toEqual(
      DurableEventManifest.Definitions.map((definition) => definition.type),
    )
    expect(sessionEventDefinitions.map((definition) => definition.type)).toEqual(
      expect.arrayContaining(
        [...SessionEvent.DurableDefinitions, ...ExternalSession.Definitions].map((definition) => definition.type),
      ),
    )
  })

  test("validates its consolidated facts with OC++'s schemas", async () => {
    const settled = sessionEvent("session-step-settled")
    const valid = await settled.schema["~standard"].validate({
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      outcome: "failed",
      error: { type: "provider.transport", message: "reset" },
      retry: { attempt: 1, at: 5 },
    })
    expect("issues" in valid ? valid.issues : undefined).toBeUndefined()
    const invalid = await settled.schema["~standard"].validate({
      sessionID: "ses_1",
      assistantMessageID: "msg_1",
      outcome: "succeeded",
    })
    expect("issues" in invalid ? invalid.issues?.length : 0).toBeGreaterThan(0)
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
