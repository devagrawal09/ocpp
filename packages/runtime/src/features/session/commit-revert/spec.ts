import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const started = event("session-execution-started", { sessionID: "ses_1" })
const settled = event("session-execution-settled", { sessionID: "ses_1", outcome: "succeeded" })
const staged = event("session-revert-staged", { sessionID: "ses_1", revert: { messageID: "msg_2", files: [] } })
const cleared = event("session-revert-cleared", { sessionID: "ses_1" })
const committed = event("session-revert-committed", { sessionID: "ses_1", to: "msg_2" })
const enqueued = (inboxID: string, delivery = "steer") =>
  event("session-inbox-enqueued", {
    sessionID: "ses_1",
    inboxID,
    item: { type: "synthetic", payload: { text: `Notice ${inboxID}` }, delivery },
  })
const admitted = (executionID: string) =>
  event("session-codemode-execution-admitted", {
    sessionID: "ses_1",
    executionID,
    assistantMessageID: "msg_3",
    toolCallID: `call_${executionID}`,
    program: { version: 1, source: "const a = 1" },
    snapshot: [],
    reserved: [],
  })
const reverted = (executionID: string) =>
  event("session-codemode-execution-settled", {
    sessionID: "ses_1",
    executionID,
    outcome: "failed",
    error: "The message that started this execution was reverted; nothing was saved.",
  })
const delivered = (inboxID: string) => event("session-inbox-delivered", { sessionID: "ses_1", inboxID })
const cancelled = (inboxID: string) => event("session-inbox-cancelled", { sessionID: "ses_1", inboxID })

export const commitRevertSpec = createCommandSlice("commitRevert")
  .description(
    "Commits the revert staged in an idle Session: its history is cut at the staged message. Input still pending belongs to the history it cuts away (a revert holds new notices while it is staged), so the commit cancels it in the same commit; the next input starts the new history. The cut takes the Code Mode notebook with it: the executions whose message it removes (the host resolves where each message sits, and every execution admitted since the stage started after it) lose their saved values, and those still running settle failed.",
  )
  .scenarios(
    {
      description: "The staged revert is committed to its message.",
      given: [created, staged],
      when: { sessionID: "ses_1" },
      expect: [committed],
    },
    {
      description: "Every input still pending is cancelled first, in the order it was admitted, in the same commit.",
      given: [
        created,
        enqueued("msg_1"),
        delivered("msg_1"),
        staged,
        enqueued("msg_3", "queue"),
        enqueued("msg_4"),
        enqueued("msg_5"),
        cancelled("msg_5"),
      ],
      when: { sessionID: "ses_1" },
      expect: [cancelled("msg_3"), cancelled("msg_4"), committed],
    },
    {
      description:
        "The Code Mode executions whose message the cut removes lose their saved values, and one still running settles failed, before the history is cut, in the same commit.",
      given: [
        created,
        admitted("exe_1"),
        event("session-codemode-execution-settled", {
          sessionID: "ses_1",
          executionID: "exe_1",
          outcome: "finished",
          values: { a: 1 },
        }),
        admitted("exe_2"),
        staged,
      ],
      when: { sessionID: "ses_1", executions: ["exe_1", "exe_2"] },
      expect: [
        reverted("exe_2"),
        event("session-codemode-notebook-reverted", { sessionID: "ses_1", executions: ["exe_1", "exe_2"] }),
        committed,
      ],
    },
    {
      description:
        "An execution admitted since the revert was staged started after the message it cuts at, so it is cut whatever the host found; a discarded one has nothing left to settle.",
      given: [
        created,
        staged,
        admitted("exe_3"),
        admitted("exe_4"),
        event("session-codemode-execution-discarded", { sessionID: "ses_1", executionID: "exe_4" }),
      ],
      when: { sessionID: "ses_1" },
      expect: [
        reverted("exe_3"),
        event("session-codemode-notebook-reverted", { sessionID: "ses_1", executions: ["exe_3", "exe_4"] }),
        committed,
      ],
    },
    {
      description: "A Session whose execution has settled is idle again.",
      given: [created, staged, started, settled],
      when: { sessionID: "ses_1" },
      expect: [committed],
    },
    {
      description: "Nothing is staged: there is nothing to commit, and the host answers as if it had committed it.",
      given: [created],
      when: { sessionID: "ses_1" },
      expect: [],
      reject: { code: "no-revert-staged" },
    },
    {
      description: "A cleared revert is no longer staged.",
      given: [created, staged, cleared],
      when: { sessionID: "ses_1" },
      expect: [],
      reject: { code: "no-revert-staged" },
    },
    {
      description: "A committed revert is no longer staged.",
      given: [created, staged, committed],
      when: { sessionID: "ses_1" },
      expect: [],
      reject: { code: "no-revert-staged" },
    },
    {
      description: "A running Session cannot commit its revert: the history would be cut under its step.",
      given: [created, staged, started],
      when: { sessionID: "ses_1" },
      expect: [],
      reject: { code: "session-busy" },
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: { sessionID: "ses_1" },
      expect: [],
      reject: { code: "session-not-found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, staged, deleted],
      when: { sessionID: "ses_1" },
      expect: [],
      reject: { code: "session-deleted" },
    },
  )

export default commitRevertSpec
