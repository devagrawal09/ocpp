import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const hash = "a".repeat(64)
const delta = { "project/agents.md": hash, "global/old.md": "removed" }
const text = "Instructions changed: project/agents.md"

export const updateInstructionsSpec = createCommandSlice("updateInstructions")
  .description(
    "Records how a live Session's instructions changed, as values referred to by hash, with the text the model is shown. The values the change introduces are stored in the same commit, before it. The host observes the change and stores nothing else.",
  )
  .scenarios(
    {
      description: "A change that introduces values stores them first, in one commit.",
      given: [created],
      when: { sessionID: "ses_1", delta, text, blobs: { [hash]: "Follow the style guide." } },
      expect: [
        event("session-instruction-blobs-stored", { sessionID: "ses_1", blobs: { [hash]: "Follow the style guide." } }),
        event("session-instructions-updated", { sessionID: "ses_1", delta, text }),
      ],
    },
    {
      description: "A change to values already stored records only the change.",
      given: [created],
      when: { sessionID: "ses_1", delta, text, blobs: {} },
      expect: [event("session-instructions-updated", { sessionID: "ses_1", delta, text })],
    },
    {
      description: "The initial baseline records an empty change without text.",
      given: [created],
      when: { sessionID: "ses_1", delta: {} },
      expect: [event("session-instructions-updated", { sessionID: "ses_1", delta: {} })],
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: { sessionID: "ses_1", delta: {} },
      expect: [],
      reject: { code: "session-not-found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, deleted],
      when: { sessionID: "ses_1", delta: {} },
      expect: [],
      reject: { code: "session-deleted" },
    },
  )

export default updateInstructionsSpec
