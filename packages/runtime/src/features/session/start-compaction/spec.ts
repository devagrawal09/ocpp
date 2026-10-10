import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const manual = { sessionID: "ses_1", reason: "manual", recent: "", inputID: "msg_1" }
const auto = { sessionID: "ses_1", reason: "auto", recent: "The last exchange" }

export const startCompactionSpec = createCommandSlice("startCompaction")
  .description(
    "Starts compacting a live Session's history: why (a delivered compaction item, or a history that no longer fits), and the recent context it keeps. A manual compaction names its inbox input. A compaction that cannot start does not start: it fails with settleCompaction.",
  )
  .scenarios(
    {
      description: "A manual compaction starts for its inbox input.",
      given: [created],
      when: manual,
      expect: [event("session-compaction-started", manual)],
    },
    {
      description: "An automatic compaction starts with the recent context it keeps.",
      given: [created],
      when: auto,
      expect: [event("session-compaction-started", auto)],
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: auto,
      expect: [],
      reject: { reason: "Session not found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, deleted],
      when: auto,
      expect: [],
      reject: { reason: "Session deleted" },
    },
  )

export default startCompactionSpec
