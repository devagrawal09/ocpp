import { createCommandSlice, event } from "@specter-ts/spec"

const created = (sessionID = "ses_1") =>
  event("session-created", {
    sessionID,
    projectID: "prj_1",
    location: { directory: "/tmp/ws" },
    slug: "brave-otter",
    version: "2",
  })
const deleted = event("session-deleted", { sessionID: "ses_1" })
const set = event("session-instruction-entry-set", { sessionID: "ses_1", key: "ticket", value: { id: 42 } })
const removed = (key = "ticket") => event("session-instruction-entry-removed", { sessionID: "ses_1", key })
const forked = event("session-forked", {
  sessionID: "ses_1",
  parentID: "ses_0",
  boundary: { type: "through", messageID: "msg_1" },
  instructionEntries: [
    { key: "ticket", value: { id: 42 }, removed: false },
    { key: "owner", value: null, removed: true },
  ],
})

export const removeInstructionEntrySpec = createCommandSlice("removeInstructionEntry")
  .description(
    "Removes an entry from a live Session's instructions. Only an entry the Session holds can be removed; a fork holds its parent's entries.",
  )
  .scenarios(
    {
      description: "An entry the Session holds is removed.",
      given: [created(), set],
      when: { sessionID: "ses_1", key: "ticket" },
      expect: [removed()],
    },
    {
      description: "A key the Session never held is refused.",
      given: [created()],
      when: { sessionID: "ses_1", key: "ticket" },
      expect: [],
      reject: { reason: "Instruction entry not found" },
    },
    {
      description: "An entry already removed is refused.",
      given: [created(), set, removed()],
      when: { sessionID: "ses_1", key: "ticket" },
      expect: [],
      reject: { reason: "Instruction entry not found" },
    },
    {
      description: "A fork removes an entry its parent held.",
      given: [created("ses_0"), created(), forked],
      when: { sessionID: "ses_1", key: "ticket" },
      expect: [removed()],
    },
    {
      description: "A fork does not hold an entry its parent had removed.",
      given: [created("ses_0"), created(), forked],
      when: { sessionID: "ses_1", key: "owner" },
      expect: [],
      reject: { reason: "Instruction entry not found" },
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: { sessionID: "ses_1", key: "ticket" },
      expect: [],
      reject: { reason: "Session not found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created(), set, deleted],
      when: { sessionID: "ses_1", key: "ticket" },
      expect: [],
      reject: { reason: "Session deleted" },
    },
  )

export default removeInstructionEntrySpec
