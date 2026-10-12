import { createCommandSlice, event } from "@specter-ts/spec"

const execution = { sessionID: "ses_1", executionID: "exe_1" }
const admitted = event("session-codemode-execution-admitted", {
  ...execution,
  assistantMessageID: "msg_1",
  toolCallID: "call_1",
  program: { version: 1, source: "await read()" },
  snapshot: [],
  reserved: [],
})
const started = event("session-codemode-execution-started", execution)
const settled = event("session-codemode-execution-settled", { ...execution, outcome: "failed", error: "Boom" })
const call = { executionID: "exe_1", index: 0, tool: "read", input: { path: "a.txt" }, omitted: false }
const scheduled = event("session-codemode-call-scheduled", { ...execution, ...call })

// A deleted Session's execution: its deletion settles it, then records its tombstone.
const deletedSettled = event("session-codemode-execution-settled", {
  ...execution,
  outcome: "failed",
  error: "The Session was deleted; nothing was saved.",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })

export const scheduleCodeModeCallSpec = createCommandSlice("scheduleCodeModeCall")
  .description(
    "Journals a tool call a running Code Mode execution makes, before the tool runs, so a resumed run can replay it. A resumed run reaches calls that are journaled already: the first record of a call wins.",
  )
  .scenarios(
    {
      description: "A running execution's call is journaled.",
      given: [admitted, started],
      when: call,
      expect: [scheduled],
    },
    {
      description: "The impure helper values the program read before the call are journaled with it.",
      given: [admitted, started],
      when: { ...call, index: 1, impure: [0.5] },
      expect: [event("session-codemode-call-scheduled", { ...execution, ...call, index: 1, impure: [0.5] })],
    },
    {
      description: "A call journaled already is refused, and the host answers as done.",
      given: [admitted, started, scheduled],
      when: call,
      expect: [],
      reject: { code: "call-already-scheduled" },
    },
    {
      description: "A settled execution is forgotten: its call is refused as unknown, which the host answers as done.",
      given: [admitted, started, settled],
      when: call,
      expect: [],
      reject: { code: "execution-not-found" },
    },
    {
      description: "An unknown execution is refused.",
      given: [],
      when: call,
      expect: [],
      reject: { code: "execution-not-found" },
    },
    {
      description: "An execution that has not started journals nothing.",
      given: [admitted],
      when: call,
      expect: [],
      reject: { code: "execution-not-running" },
    },
    {
      description: "An execution discarded before it started is forgotten: its call is refused as unknown.",
      given: [admitted, event("session-codemode-execution-discarded", execution)],
      when: call,
      expect: [],
      reject: { code: "execution-not-found" },
    },
    {
      description: "A deleted Session's execution is gone: its deletion settled it, and its tombstone forgets it.",
      given: [admitted, started, deletedSettled, deleted],
      when: call,
      expect: [],
      reject: { code: "execution-not-found" },
    },
  )

export default scheduleCodeModeCallSpec
