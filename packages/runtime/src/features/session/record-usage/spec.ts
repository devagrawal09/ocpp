import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const input = {
  sessionID: "ses_1",
  source: "title",
  cost: 0.01,
  tokens: { input: 10, output: 4, reasoning: 0, cache: { read: 0, write: 0 } },
}

export const recordUsageSpec = createCommandSlice("recordUsage")
  .description("Records what a live Session spent outside its steps: generating its title, or compacting its history.")
  .scenarios(
    {
      description: "The usage counts toward the Session.",
      given: [created],
      when: input,
      expect: [event("session-usage-recorded", input)],
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

export default recordUsageSpec
