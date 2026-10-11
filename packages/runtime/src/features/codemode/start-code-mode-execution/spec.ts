import { createCommandSlice, event } from "@specter-ts/spec"

const execution = { sessionID: "ses_1", executionID: "exe_1" }
const admitted = event("session-codemode-execution-admitted", {
  ...execution,
  assistantMessageID: "msg_1",
  toolCallID: "call_1",
  program: { version: 1, source: "const a = 1" },
  snapshot: [],
  reserved: ["a"],
})
const started = event("session-codemode-execution-started", execution)
const settled = event("session-codemode-execution-settled", { ...execution, outcome: "failed", error: "Boom" })
const discarded = event("session-codemode-execution-discarded", execution)

export const startCodeModeExecutionSpec = createCommandSlice("startCodeModeExecution")
  .description(
    "Records that an admitted Code Mode execution started running, once its tool result committed: from here its calls are journaled, and a restart resumes it. An execution starts once.",
  )
  .scenarios(
    {
      description: "An admitted execution starts.",
      given: [admitted],
      when: { executionID: "exe_1" },
      expect: [started],
    },
    {
      description: "A running execution is refused, and the host answers as done.",
      given: [admitted, started],
      when: { executionID: "exe_1" },
      expect: [],
      reject: { code: "execution-already-started" },
    },
    {
      description: "A settled execution is refused too.",
      given: [admitted, settled],
      when: { executionID: "exe_1" },
      expect: [],
      reject: { code: "execution-already-started" },
    },
    {
      description: "An execution never admitted, or discarded, is refused.",
      given: [admitted, discarded],
      when: { executionID: "exe_1" },
      expect: [],
      reject: { code: "execution-not-found" },
    },
  )

export default startCodeModeExecutionSpec
