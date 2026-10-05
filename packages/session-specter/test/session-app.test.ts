import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { deltaText, readLog } from "../src/delta-log"
import { fakeModel } from "../src/fake-model"
import { closeAllSessionApps, openSessionApp } from "../src/session-app"

const roots: string[] = []

afterEach(async () => {
  await closeAllSessionApps()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), "session-specter-"))
  roots.push(root)
  return root
}

test("runs queued prompts one execution at a time and records coalesced deltas", async () => {
  const root = await tempRoot()
  const session = await openSessionApp({
    root,
    sessionId: "ses_1",
    model: fakeModel({ tokens: 40, delayMs: 2, toolCall: true }),
  })
  expect(await openSessionApp({ root, sessionId: "ses_1" })).toBe(session)
  await Effect.runPromise(session.app.command({ type: "createSession", payload: { sessionId: "ses_1" } }))
  await Effect.runPromise(session.app.command({ type: "enqueuePrompt", payload: { promptId: "prm_1", text: "one" } }))
  await Effect.runPromise(session.app.command({ type: "enqueuePrompt", payload: { promptId: "prm_2", text: "two" } }))
  await session.awaitIdle()

  const status = await Effect.runPromise(session.app.query({ type: "sessionStatus", payload: {} }))
  expect(status).toEqual({ status: "idle", executionId: null, queued: 0, succeeded: 2, failed: 0 })
  const messages = await Effect.runPromise(session.app.query({ type: "sessionMessages", payload: {} }))
  expect(messages.map((message) => `${message.role}:${message.id}`)).toEqual([
    "user:prm_1",
    "assistant:msg_exe_prm_1",
    "user:prm_2",
    "assistant:msg_exe_prm_2",
  ])
  const assistant = messages[1]
  if (assistant.role !== "assistant") throw new Error("expected assistant message")
  expect(assistant.parts.map((part) => part.type)).toEqual(["text", "tool"])

  const deltas = await readLog(join(session.sessionDir, "steps", "exe_prm_1.jsonl"), 0)
  const events = deltas.records.flatMap((record) => record.events)
  expect(deltaText(deltas.records)).toBe(assistant.parts[0].type === "text" ? assistant.parts[0].text : "")
  expect(events.filter((event) => event.type === "text-delta").length).toBeLessThan(40)
  expect(events.at(-1)?.type).toBe("step-ended")
})

test("reopening does not run finished turns again", async () => {
  const root = await tempRoot()
  const first = await openSessionApp({ root, sessionId: "ses_1", model: fakeModel({ tokens: 5 }) })
  await Effect.runPromise(first.app.command({ type: "createSession", payload: { sessionId: "ses_1" } }))
  await Effect.runPromise(first.app.command({ type: "enqueuePrompt", payload: { promptId: "prm_1", text: "one" } }))
  await first.awaitIdle()
  await first.close()

  for (const reactionStore of ["jsonl", "memory"] as const) {
    const reopened = await openSessionApp({ root, sessionId: "ses_1", reactionStore, pollIntervalMs: 5 })
    await Bun.sleep(50)
    const status = await Effect.runPromise(reopened.app.query({ type: "sessionStatus", payload: {} }))
    expect(status.succeeded).toBe(1)
    const jobs = await Effect.runPromise(reopened.outbox.list())
    expect(jobs.map((job) => job.status)).toEqual(["completed"])
    await reopened.close()
  }
})

test("records a model failure as a failed execution", async () => {
  const root = await tempRoot()
  const session = await openSessionApp({ root, sessionId: "ses_1", model: fakeModel({ tokens: 10, failAfter: 3 }) })
  await Effect.runPromise(session.app.command({ type: "createSession", payload: { sessionId: "ses_1" } }))
  await Effect.runPromise(session.app.command({ type: "enqueuePrompt", payload: { promptId: "prm_1", text: "one" } }))
  await session.awaitIdle()
  const status = await Effect.runPromise(session.app.query({ type: "sessionStatus", payload: {} }))
  expect(status).toEqual({ status: "idle", executionId: null, queued: 0, succeeded: 0, failed: 1 })
})
