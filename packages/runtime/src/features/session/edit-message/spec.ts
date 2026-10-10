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
// The host checked the message: a completed assistant message of the Session, with no tool still running.
const edit = {
  sessionID: "ses_1",
  messageID: "msg_1",
  content: [{ type: "text", text: "Edited" }],
}

export const editMessageSpec = createCommandSlice("editMessage")
  .description(
    "Replaces the content of a completed assistant message of an idle Session. The host checks the message; the Session must not be running, since a step builds on its history.",
  )
  .scenarios(
    {
      description: "An idle Session's message takes the new content.",
      given: [created],
      when: edit,
      expect: [event("session-message-content-updated", edit)],
    },
    {
      description: "A Session whose execution has settled is idle again.",
      given: [created, started, settled],
      when: edit,
      expect: [event("session-message-content-updated", edit)],
    },
    {
      description: "A running Session's history cannot change under its step.",
      given: [created, started],
      when: edit,
      expect: [],
      reject: { reason: "Session is busy" },
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: edit,
      expect: [],
      reject: { reason: "Session not found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, deleted],
      when: edit,
      expect: [],
      reject: { reason: "Session deleted" },
    },
  )

export default editMessageSpec
