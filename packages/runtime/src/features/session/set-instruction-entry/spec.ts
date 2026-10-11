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
const set = (value: string | { id: number }, key = "ticket") =>
  event("session-instruction-entry-set", { sessionID: "ses_1", key, value })
const removed = event("session-instruction-entry-removed", { sessionID: "ses_1", key: "ticket" })
const forked = event("session-forked", {
  sessionID: "ses_1",
  parentID: "ses_0",
  boundary: { type: "through", messageID: "msg_1" },
  instructionEntries: [
    { key: "ticket", value: { id: 42 }, removed: false },
    { key: "owner", value: null, removed: true },
  ],
})

export const setInstructionEntrySpec = createCommandSlice("setInstructionEntry")
  .description(
    "Attaches a JSON value to a live Session's instructions under a key, or changes it. Setting the value an entry already holds records nothing. A fork starts with its parent's entries.",
  )
  .scenarios(
    {
      description: "A new key attaches its value.",
      given: [created()],
      when: { sessionID: "ses_1", key: "ticket", value: { id: 42 } },
      expect: [set({ id: 42 })],
    },
    {
      description: "Another value replaces the entry's.",
      given: [created(), set({ id: 42 })],
      when: { sessionID: "ses_1", key: "ticket", value: { id: 43 } },
      expect: [set({ id: 43 })],
    },
    {
      description: "The value the entry already holds is refused: there is nothing to change.",
      given: [created(), set({ id: 42 })],
      when: { sessionID: "ses_1", key: "ticket", value: { id: 42 } },
      expect: [],
      reject: { code: "instruction-entry-unchanged" },
    },
    {
      description: "A removed entry takes its value again.",
      given: [created(), set({ id: 42 }), removed],
      when: { sessionID: "ses_1", key: "ticket", value: { id: 42 } },
      expect: [set({ id: 42 })],
    },
    {
      description: "A fork holds its parent's entries, so setting one of them to the same value changes nothing.",
      given: [created("ses_0"), created(), forked],
      when: { sessionID: "ses_1", key: "ticket", value: { id: 42 } },
      expect: [],
      reject: { code: "instruction-entry-unchanged" },
    },
    {
      description: "An entry the parent had removed is set on the fork.",
      given: [created("ses_0"), created(), forked],
      when: { sessionID: "ses_1", key: "owner", value: "dev" },
      expect: [set("dev", "owner")],
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: { sessionID: "ses_1", key: "ticket", value: { id: 42 } },
      expect: [],
      reject: { code: "session-not-found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created(), deleted],
      when: { sessionID: "ses_1", key: "ticket", value: { id: 42 } },
      expect: [],
      reject: { code: "session-deleted" },
    },
  )

export default setInstructionEntrySpec
