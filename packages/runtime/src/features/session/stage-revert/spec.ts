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

// What the host found for the boundary: the snapshot to restore files from
// and their diffs, which it restored before staging.
const revert = (messageID = "msg_2") => ({ messageID, snapshot: "tree_1", files: [] })
const staged = (messageID = "msg_2") =>
  event("session-revert-staged", { sessionID: "ses_1", revert: revert(messageID) })

export const stageRevertSpec = createCommandSlice("stageRevert")
  .description(
    "Stages a revert of an idle Session to a message: its history is cut there when the revert is committed, and a clear restores it. The host checks the message and restores the files first.",
  )
  .scenarios(
    {
      description: "An idle Session stages a revert to a message.",
      given: [created],
      when: { sessionID: "ses_1", revert: revert() },
      expect: [staged()],
    },
    {
      description: "A new stage replaces the staged revert; staging never fails because one is staged.",
      given: [created, staged()],
      when: { sessionID: "ses_1", revert: revert("msg_1") },
      expect: [staged("msg_1")],
    },
    {
      description: "A Session whose execution has settled is idle again.",
      given: [created, started, settled],
      when: { sessionID: "ses_1", revert: revert() },
      expect: [staged()],
    },
    {
      description: "A running Session cannot stage a revert.",
      given: [created, started],
      when: { sessionID: "ses_1", revert: revert() },
      expect: [],
      reject: { reason: "Session is busy" },
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: { sessionID: "ses_1", revert: revert() },
      expect: [],
      reject: { reason: "Session not found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, deleted],
      when: { sessionID: "ses_1", revert: revert() },
      expect: [],
      reject: { reason: "Session deleted" },
    },
  )

export default stageRevertSpec
