import { createCommandSlice, event } from "@specter-ts/spec"

const recovery = { kind: "codemode", parentSessionID: "ses_1", assistantMessageID: "msg_1", toolCallID: "call_1" }
const started = event("session-background-started", {
  notificationID: "msg_n1",
  sessionID: "ses_1",
  jobID: "exe_1",
  recovery,
})
const terminal = event("session-background-terminal", { notificationID: "msg_n1", sessionID: "ses_1" })
const completed = event("session-background-completed", { notificationID: "msg_n1", sessionID: "ses_1" })
const codemodeSettled = event("session-codemode-settled", {
  sessionID: "ses_1",
  assistantMessageID: "msg_1",
  id: "call_1",
  executionID: "exe_1",
  events: [],
  outcome: "completed",
})

export const markBackgroundTerminalSpec = createCommandSlice("markBackgroundTerminal")
  .description(
    "Marks that a background job's outcome reached its Session: only its notification is left to deliver. A Code Mode run's settlement does this by itself. A marker is terminal once, and stays terminal when its job resumes.",
  )
  .scenarios(
    {
      description: "A marker whose job's outcome reached its Session becomes terminal.",
      given: [started],
      when: { notificationID: "msg_n1" },
      expect: [terminal],
    },
    {
      description: "A terminal marker is refused: it is terminal already.",
      given: [started, terminal],
      when: { notificationID: "msg_n1" },
      expect: [],
      reject: { code: "background-job-already-terminal" },
    },
    {
      description: "A Code Mode run's settlement made its marker terminal.",
      given: [started, codemodeSettled],
      when: { notificationID: "msg_n1" },
      expect: [],
      reject: { code: "background-job-already-terminal" },
    },
    {
      description: "A resumed job's marker stays terminal.",
      given: [started, terminal, started],
      when: { notificationID: "msg_n1" },
      expect: [],
      reject: { code: "background-job-already-terminal" },
    },
    {
      description: "A notification without a marker is refused.",
      given: [],
      when: { notificationID: "msg_n1" },
      expect: [],
      reject: { code: "background-job-not-found" },
    },
    {
      description: "A completed marker is gone.",
      given: [started, completed],
      when: { notificationID: "msg_n1" },
      expect: [],
      reject: { code: "background-job-not-found" },
    },
    {
      description: "A deleted Session's marker is gone: its deletion completed it, and its tombstone forgets it.",
      given: [started, completed, event("session-deleted", { sessionID: "ses_1" })],
      when: { notificationID: "msg_n1" },
      expect: [],
      reject: { code: "background-job-not-found" },
    },
  )

export default markBackgroundTerminalSpec
