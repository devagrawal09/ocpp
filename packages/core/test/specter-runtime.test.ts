import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { Effect } from "effect"
import { ExternalSession } from "@ocpp/schema/external-session"
import { SessionEvent } from "@ocpp/schema/session-event"
import { sessionEvent, sessionEventDefinitions } from "@ocpp/session-runtime"
import { SpecterTranslate } from "../src/specter/translate"

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

  test("defines OC++'s durable Session facts under their own names", () => {
    expect(sessionEventDefinitions.map((definition) => definition.type)).toEqual(
      expect.arrayContaining(
        [...SessionEvent.DurableDefinitions, ...ExternalSession.Definitions].map((definition) => definition.type),
      ),
    )
  })

  test("projects an external agent's Session facts as OC++'s own", () => {
    expect(
      SpecterTranslate.toWire({
        id: "evt_1",
        type: "session-external-linked",
        payload: { sessionID: "ses_1", vendorSessionID: "vendor_1" },
        order: 1,
        recordedAt: new Date(0).toISOString(),
      }).map((wire) => [wire.definition.type, wire.data]),
    ).toEqual([[ExternalSession.Linked.type, { sessionID: "ses_1", vendorSessionID: "vendor_1" }]])
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
    expect(settled({ outcome: "succeeded" })).toEqual([
      ["session-execution-succeeded", { sessionID: "ses_1" }, "evt_1"],
    ])
    expect(settled({ outcome: "failed", error: { type: "provider", message: "boom" } })).toEqual([
      ["session-execution-failed", { sessionID: "ses_1", error: { type: "provider", message: "boom" } }, "evt_1"],
    ])
    expect(settled({ outcome: "interrupted", reason: "user" })).toEqual([
      ["session-execution-interrupted", { sessionID: "ses_1", reason: "user" }, "evt_1"],
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
        "session-step-ended",
        { sessionID: "ses_1", assistantMessageID: "msg_1", finish: "stop", cost: 0, tokens },
        "evt_2",
      ],
    ])
    expect(step({ outcome: "failed", error })).toEqual([
      ["session-step-failed", { sessionID: "ses_1", assistantMessageID: "msg_1", error }, "evt_2"],
    ])
    // A transparent retry is only scheduled; a fresh one follows a failed step.
    expect(step({ outcome: "failed", error, retry: { attempt: 1, at: 5 } })).toEqual([
      [
        "session-retry-scheduled",
        { sessionID: "ses_1", assistantMessageID: "msg_1", attempt: 2, at: 5, error },
        "evt_2_retry",
      ],
    ])
    expect(step({ outcome: "failed", error, retry: { attempt: 1, at: 5, fresh: true } })).toEqual([
      ["session-step-failed", { sessionID: "ses_1", assistantMessageID: "msg_1", error }, "evt_2"],
      [
        "session-retry-scheduled",
        { sessionID: "ses_1", assistantMessageID: "msg_1", attempt: 2, at: 5, error },
        "evt_2_retry",
      ],
    ])
    const block = (kind: string) =>
      SpecterTranslate.toWire({
        id: "evt_4",
        order: 4,
        type: "session-block-recorded",
        payload: { sessionID: "ses_1", assistantMessageID: "msg_1", kind, ordinal: 0, text: "hi" },
        recordedAt: new Date(0).toISOString(),
      }).map((wire) => [wire.definition.type, wire.data, wire.id])
    const position = { sessionID: "ses_1", assistantMessageID: "msg_1", ordinal: 0 }
    expect(block("text")).toEqual([
      ["session-text-started", position, "evt_4_start"],
      ["session-text-ended", { ...position, text: "hi" }, "evt_4"],
    ])
    expect(block("reasoning")).toEqual([
      ["session-reasoning-started", position, "evt_4_start"],
      ["session-reasoning-ended", { ...position, text: "hi" }, "evt_4"],
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
      ["session-tool-input-started", { ...call, name: "execute" }, "evt_3_input"],
      ["session-tool-input-ended", { ...call, text: '{"code":"1"}' }, "evt_3_text"],
      ["session-tool-called", { ...call, input: { code: "1" }, executed: false }, "evt_3"],
    ])
    const content = [{ type: "text", text: "2" }]
    expect(tool("session-tool-settled", { outcome: "succeeded", content, executed: true })).toEqual([
      ["session-tool-success", { ...call, content, executed: true }, "evt_3"],
    ])
    expect(tool("session-tool-settled", { outcome: "failed", error, executed: false })).toEqual([
      ["session-tool-failed", { ...call, error, executed: false }, "evt_3"],
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
