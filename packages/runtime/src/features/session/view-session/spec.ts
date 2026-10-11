import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const input = { sessionID: "ses_1", idle: 1700000000000 }

export const viewSessionSpec = createCommandSlice("viewSession")
  .description(
    "Records that a viewer saw a live Session as of an idle time. Whether that time is newer than what was viewed is the host's to decide from its projection: the idle watermark is the time its execution settled, which only the host's events carry.",
  )
  .scenarios(
    {
      description: "A viewer saw the Session as of an idle time.",
      given: [created],
      when: input,
      expect: [event("session-viewed", input)],
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

export default viewSessionSpec
