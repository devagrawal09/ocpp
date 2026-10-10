import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const input = { sessionID: "ses_1", id: "effect", name: "Effect", text: "Use Effect" }

export const activateSkillSpec = createCommandSlice("activateSkill")
  .description("Activates a skill in a live Session: its text enters the Session's history.")
  .scenarios(
    {
      description: "The skill's text enters the Session.",
      given: [created],
      when: input,
      expect: [event("session-skill-activated", input)],
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

export default activateSkillSpec
