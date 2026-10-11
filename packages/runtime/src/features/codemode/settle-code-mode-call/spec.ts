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
const scheduled = event("session-codemode-call-scheduled", {
  ...execution,
  index: 0,
  tool: "read",
  input: { path: "a.txt" },
  omitted: false,
})
const completed = { executionID: "exe_1", index: 0, outcome: "completed", output: "text", omitted: false }
const interrupted = {
  executionID: "exe_1",
  index: 0,
  outcome: "indeterminate",
  error: "Interrupted by shutdown",
  omitted: false,
}

export const settleCodeModeCallSpec = createCommandSlice("settleCodeModeCall")
  .description(
    "Settles a journaled call of a running Code Mode execution: completed with its output, failed with its error, or indeterminate when a shutdown interrupted it. An indeterminate call settles again when a resumed run reaches it; a call that completed or failed settles once.",
  )
  .scenarios(
    {
      description: "A journaled call completes with its output.",
      given: [admitted, started, scheduled],
      when: completed,
      expect: [event("session-codemode-call-settled", { ...execution, ...completed })],
    },
    {
      description: "A call a shutdown interrupted is indeterminate until a resumed run settles it again.",
      given: [admitted, started, scheduled, event("session-codemode-call-settled", { ...execution, ...interrupted })],
      when: completed,
      expect: [event("session-codemode-call-settled", { ...execution, ...completed })],
    },
    {
      description: "A call that completed is refused.",
      given: [admitted, started, scheduled, event("session-codemode-call-settled", { ...execution, ...completed })],
      when: completed,
      expect: [],
      reject: { reason: "Call already settled" },
    },
    {
      description: "A call never journaled is refused.",
      given: [admitted, started],
      when: completed,
      expect: [],
      reject: { reason: "Call not scheduled" },
    },
    {
      description: "A settled execution's call is refused.",
      given: [admitted, started, scheduled, settled],
      when: completed,
      expect: [],
      reject: { reason: "Execution not running" },
    },
    {
      description: "An unknown execution is refused.",
      given: [],
      when: completed,
      expect: [],
      reject: { reason: "Execution not found" },
    },
  )

export default settleCodeModeCallSpec
