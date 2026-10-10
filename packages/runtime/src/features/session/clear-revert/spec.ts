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

export const clearRevertSpec = createCommandSlice("clearRevert")
  .description(
    "Clears the revert staged in an idle Session, leaving its history whole. The host restores the files the stage changed first.",
  )
  .scenarios(
    {
      description: "The staged revert is cleared.",
      given: [created, staged],
      when: { sessionID: "ses_1" },
      expect: [cleared],
    },
    {
      description: "A Session whose execution has settled is idle again.",
      given: [created, staged, started, settled],
      when: { sessionID: "ses_1" },
      expect: [cleared],
    },
    {
      description: "Nothing is staged: there is nothing to clear, and the host answers as if it had cleared it.",
      given: [created],
      when: { sessionID: "ses_1" },
      expect: [],
      reject: { reason: "No revert staged" },
    },
    {
      description: "A cleared revert is no longer staged.",
      given: [created, staged, cleared],
      when: { sessionID: "ses_1" },
      expect: [],
      reject: { reason: "No revert staged" },
    },
    {
      description: "A committed revert is no longer staged.",
      given: [created, staged, committed],
      when: { sessionID: "ses_1" },
      expect: [],
      reject: { reason: "No revert staged" },
    },
    {
      description: "A running Session cannot clear its revert.",
      given: [created, staged, started],
      when: { sessionID: "ses_1" },
      expect: [],
      reject: { reason: "Session is busy" },
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: { sessionID: "ses_1" },
      expect: [],
      reject: { reason: "Session not found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, staged, deleted],
      when: { sessionID: "ses_1" },
      expect: [],
      reject: { reason: "Session deleted" },
    },
  )

export default clearRevertSpec
