import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const input = { sessionID: "ses_1", title: "Report", blocks: [{ type: "markdown", text: "Done" }] }

export const displayResultSpec = createCommandSlice("displayResult")
  .description(
    "Displays a result in a live Session's timeline: it never enters the model's history. The host names the event, from which the displayed message takes its ID.",
  )
  .scenarios(
    {
      description: "The result is displayed.",
      given: [created],
      when: input,
      expect: [event("session-displayed", input)],
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: input,
      expect: [],
      reject: { reason: "Session not found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, deleted],
      when: input,
      expect: [],
      reject: { reason: "Session deleted" },
    },
  )

export default displayResultSpec
