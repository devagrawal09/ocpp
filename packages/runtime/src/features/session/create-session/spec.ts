import { createCommandSlice, event } from "@specter-ts/spec"

// The identity the host chose for a Session: its ID, project, Location, slug
// and version. Optional fields are the host's too.
const identity = (sessionID = "ses_1", extra: Record<string, unknown> = {}) => ({
  sessionID,
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
  ...extra,
})
const created = (sessionID = "ses_1", extra: Record<string, unknown> = {}) =>
  event("session-created", identity(sessionID, extra))
const deleted = (sessionID = "ses_1") => event("session-deleted", { sessionID })

// A Session exported by another server: its settled messages and accounting.
const history = {
  messages: [{ id: "msg_1", type: "user", seq: 1, created: 1, data: { text: "Hello" } }],
  cost: 0.25,
  tokens: { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  time: { created: 1, updated: 2, idle: 2 },
  outcome: "succeeded",
}

export const createSessionSpec = createCommandSlice("createSession")
  .description(
    "Creates a Session with the identity the host chose. An ID names one Session for good: a live or deleted Session's ID is refused, and a child's parent must be live. A Session imported from another server records its history in the same commit.",
  )
  .scenarios(
    {
      description: "A new Session is recorded with the identity it was given.",
      given: [],
      when: { session: identity() },
      expect: [created()],
    },
    {
      description: "A child Session names its live parent, and keeps the host's optional fields.",
      given: [created("ses_parent")],
      when: { session: identity("ses_1", { parentID: "ses_parent", title: "Child", agent: "explore" }) },
      expect: [created("ses_1", { parentID: "ses_parent", title: "Child", agent: "explore" })],
    },
    {
      description: "An imported Session records its history with its creation, in one commit.",
      given: [],
      when: { session: identity(), imported: history },
      expect: [created(), event("session-imported", { sessionID: "ses_1", ...history })],
    },
    {
      description: "Reusing a live Session's ID is refused; the host adopts the existing Session.",
      given: [created()],
      when: { session: identity("ses_1", { title: "Again" }) },
      expect: [],
      reject: { reason: "Session already exists" },
    },
    {
      description: "A deleted Session's ID is not given to a new Session.",
      given: [created(), deleted()],
      when: { session: identity() },
      expect: [],
      reject: { reason: "Session deleted" },
    },
    {
      description: "A child of an unknown Session is refused.",
      given: [],
      when: { session: identity("ses_1", { parentID: "ses_missing" }) },
      expect: [],
      reject: { reason: "Parent session not found" },
    },
    {
      description: "A child of a deleted Session is refused.",
      given: [created("ses_parent"), deleted("ses_parent")],
      when: { session: identity("ses_1", { parentID: "ses_parent" }) },
      expect: [],
      reject: { reason: "Parent session deleted" },
    },
  )

export default createSessionSpec
