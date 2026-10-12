import { createCommandSlice, event } from "@specter-ts/spec"

const execution = { sessionID: "ses_1", executionID: "exe_1" }
const admitted = event("session-codemode-execution-admitted", {
  ...execution,
  assistantMessageID: "msg_1",
  toolCallID: "call_1",
  program: { version: 1, source: "await task()" },
  snapshot: [],
  reserved: [],
})
const started = event("session-codemode-execution-started", execution)
const settled = event("session-codemode-execution-settled", { ...execution, outcome: "failed", error: "Boom" })
const scheduled = event("session-codemode-call-scheduled", {
  ...execution,
  index: 0,
  tool: "task",
  input: { prompt: "Plan" },
  omitted: false,
})
const progress = { executionID: "exe_1", index: 0, progress: { sessionID: "ses_child" } }

// A deleted Session's execution: its deletion settles it, then records its tombstone.
const deletedSettled = event("session-codemode-execution-settled", {
  ...execution,
  outcome: "failed",
  error: "The Session was deleted; nothing was saved.",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })

export const progressCodeModeCallSpec = createCommandSlice("progressCodeModeCall")
  .description(
    "Records the latest progress of a journaled call that can rejoin its work after a restart, such as the child Session a subagent call runs in.",
  )
  .scenarios(
    {
      description: "A journaled call's progress is recorded.",
      given: [admitted, started, scheduled],
      when: progress,
      expect: [event("session-codemode-call-progressed", { ...execution, ...progress })],
    },
    {
      description: "A call never journaled is refused.",
      given: [admitted, started],
      when: progress,
      expect: [],
      reject: { code: "call-not-scheduled" },
    },
    {
      description:
        "A settled execution is forgotten, with its calls: its call is refused as unknown, which the host answers as done.",
      given: [admitted, started, scheduled, settled],
      when: progress,
      expect: [],
      reject: { code: "execution-not-found" },
    },
    {
      description: "An unknown execution is refused.",
      given: [],
      when: progress,
      expect: [],
      reject: { code: "execution-not-found" },
    },
    {
      description: "An execution discarded before it started is forgotten: its call is refused as unknown.",
      given: [admitted, event("session-codemode-execution-discarded", execution)],
      when: progress,
      expect: [],
      reject: { code: "execution-not-found" },
    },
    {
      description: "A deleted Session's execution is gone: its deletion settled it, and its tombstone forgets it.",
      given: [admitted, started, scheduled, deletedSettled, deleted],
      when: progress,
      expect: [],
      reject: { code: "execution-not-found" },
    },
  )

export default progressCodeModeCallSpec
