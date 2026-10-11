import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const input = { sessionID: "ses_1", text: "Continue from where you left off.", description: "Continuing after restart" }

export const appendSyntheticSpec = createCommandSlice("appendSynthetic")
  .description(
    "Appends a synthetic message to a live Session's history directly, not through its inbox: instructions a tool loaded, or a notice that the turn goes on (after an incomplete stream or a restart).",
  )
  .scenarios(
    {
      description: "The message enters the Session's history.",
      given: [created],
      when: input,
      expect: [event("session-synthetic", input)],
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: input,
      expect: [],
      reject: { code: "session-not-found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, deleted],
      when: input,
      expect: [],
      reject: { code: "session-deleted" },
    },
  )

export default appendSyntheticSpec
