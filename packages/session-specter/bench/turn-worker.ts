// Child process for the kill/recover phase of spike.ts: `start` opens a fresh Session and
// enqueues one prompt; `resume` reopens the same root and lets the outbox finish the turn.
import { Effect } from "effect"
import { fakeModel } from "../src/fake-model"
import { openSessionApp } from "../src/session-app"

const root = Bun.argv[2]
const sessionId = Bun.argv[3]
const session = await openSessionApp({
  root,
  sessionId,
  model: fakeModel({ tokens: 300, delayMs: 5, toolCall: true }),
  pollIntervalMs: 10,
})
if (Bun.argv[4] === "start") {
  await Effect.runPromise(session.app.command({ type: "createSession", payload: { sessionId } }))
  await Effect.runPromise(
    session.app.command({ type: "enqueuePrompt", payload: { promptId: "prm_kill", text: "survive a crash" } }),
  )
}
await session.awaitIdle()
await session.close()
console.log("idle")
