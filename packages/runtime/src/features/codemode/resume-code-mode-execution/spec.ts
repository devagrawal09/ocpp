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

export const resumeCodeModeExecutionSpec = createCommandSlice("resumeCodeModeExecution")
  .description(
    "Records that a running Code Mode execution resumed after its host restarted, replaying its journal. Only a running execution resumes.",
  )
  .scenarios(
    {
      description: "A running execution resumes.",
      given: [admitted, started],
      when: { executionID: "exe_1" },
      expect: [event("session-codemode-execution-resumed", execution)],
    },
    {
      description: "An execution that never started is refused.",
      given: [admitted],
      when: { executionID: "exe_1" },
      expect: [],
      reject: { code: "execution-not-running" },
    },
    {
      description: "A settled execution is refused.",
      given: [admitted, started, settled],
      when: { executionID: "exe_1" },
      expect: [],
      reject: { code: "execution-not-running" },
    },
    {
      description: "An execution never admitted, or discarded, is refused.",
      given: [admitted, discarded],
      when: { executionID: "exe_1" },
      expect: [],
      reject: { code: "execution-not-found" },
    },
  )

export default resumeCodeModeExecutionSpec
