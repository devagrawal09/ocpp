import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const input = { sessionID: "ses_1", tools: ["read", "glob"] }

export const selectToolsSpec = createCommandSlice("selectTools")
  .description("Selects the Code Mode paths a live subagent Session may call.")
  .scenarios(
    {
      description: "The Session may call the selected paths.",
      given: [created],
      when: input,
      expect: [event("session-tools-selected", input)],
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

export default selectToolsSpec
