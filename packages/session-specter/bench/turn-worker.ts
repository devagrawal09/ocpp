// Child process for the kill/recover phase of spike.ts: `start` opens a fresh Session and
// enqueues one prompt; `resume` reopens the same root and lets the outbox finish the turn.
import { fakeModel } from "../src/fake-model"
import { realModel } from "../src/real-model"
import { openSessionApp } from "../src/session-app"

const root = Bun.argv[2]
const sessionId = Bun.argv[3]
const session = await openSessionApp({
  root,
  sessionId,
  model:
    process.env.SESSION_SPECTER_MODEL === "real"
      ? await realModel()
      : fakeModel({ tokens: 300, delayMs: 5, toolCall: true }),
})
if (Bun.argv[4] === "start") {
  await session.app.command({ type: "createSession", payload: { sessionId } })
  await session.app.command({ type: "enqueuePrompt", payload: { promptId: "prm_kill", text: "survive a crash" } })
}
await session.awaitIdle()
await session.close()
console.log("idle")
