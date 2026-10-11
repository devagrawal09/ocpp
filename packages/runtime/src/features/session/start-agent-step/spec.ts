import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const executionStarted = event("session-execution-started", { sessionID: "ses_1" })
const executionSettled = event("session-execution-settled", { sessionID: "ses_1", outcome: "succeeded" })
const step = (assistantMessageID = "msg_a1") => ({
  sessionID: "ses_1",
  assistantMessageID,
  agent: "build",
  model: { id: "sonnet", providerID: "claude" },
})

export const startAgentStepSpec = createCommandSlice("startAgentStep")
  .description(
    "Starts a step an external agent produces in the execution the host drives: the agent's output and calls are recorded under it until finishAgentStep. The agent decides its own steps, so a step its stopped process left in flight does not hold the next one back.",
  )
  .scenarios(
    {
      description: "A step starts in the Session's running execution.",
      given: [created, executionStarted],
      when: step(),
      expect: [event("session-step-started", step())],
    },
    {
      description: "A step a stopped process left in flight does not hold the next one back.",
      given: [created, executionStarted, event("session-step-started", step())],
      when: step("msg_a2"),
      expect: [event("session-step-started", step("msg_a2"))],
    },
    {
      description: "A Session with no running execution is refused.",
      given: [created, executionStarted, executionSettled],
      when: step(),
      expect: [],
      reject: { code: "execution-not-active" },
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: step(),
      expect: [],
      reject: { code: "session-not-found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, deleted],
      when: step(),
      expect: [],
      reject: { code: "session-deleted" },
    },
  )

export default startAgentStepSpec
