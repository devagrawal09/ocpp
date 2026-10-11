import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const base = { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", executionID: "exe_1" }
const completed = { ...base, events: [], outcome: "completed" }
const cancelled = { ...base, events: [], outcome: "cancelled", error: "Cancelled" }

export const settleCodeModeSpec = createCommandSlice("settleCodeMode")
  .description(
    "Records in a live Session how a Code Mode execution ended, with the trace it ended with: completed, or error or cancelled with the error. It settles the call or the invocation message that owns the execution, once. Restart recovery settles an execution without a trace, even one whose start a stopped process never recorded.",
  )
  .scenarios(
    {
      description: "An execution completes with its trace.",
      given: [created],
      when: completed,
      expect: [event("session-codemode-settled", completed)],
    },
    {
      description: "A cancelled execution settles with its error.",
      given: [created],
      when: cancelled,
      expect: [event("session-codemode-settled", cancelled)],
    },
    {
      description: "An execution that settled is refused.",
      given: [created, event("session-codemode-settled", completed)],
      when: cancelled,
      expect: [],
      reject: { code: "code-mode-already-settled" },
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: completed,
      expect: [],
      reject: { code: "session-not-found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, deleted],
      when: completed,
      expect: [],
      reject: { code: "session-deleted" },
    },
  )

export default settleCodeModeSpec
