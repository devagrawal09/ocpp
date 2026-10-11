import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const bound = event("session-external-bound", { sessionID: "ses_1", provider: "claude", directory: "/tmp/ws" })
const checkpoint = { sessionID: "ses_1", checkpoint: "checkpoint_1", historyHash: "hash_1" }

export const checkpointVendorSessionSpec = createCommandSlice("checkpointVendorSession")
  .description(
    "Records a bound Session's vendor checkpoint at a settled boundary: the fingerprint of the vendor's history and of the canonical history it answers, which decide whether the vendor session can continue.",
  )
  .scenarios(
    {
      description: "A bound Session records its vendor checkpoint.",
      given: [created, bound],
      when: checkpoint,
      expect: [event("session-external-checkpointed", checkpoint)],
    },
    {
      description: "A Session that no external agent runs is refused.",
      given: [created],
      when: checkpoint,
      expect: [],
      reject: { code: "external-agent-not-bound" },
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: checkpoint,
      expect: [],
      reject: { code: "session-not-found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, bound, deleted],
      when: checkpoint,
      expect: [],
      reject: { code: "session-deleted" },
    },
  )

export default checkpointVendorSessionSpec
