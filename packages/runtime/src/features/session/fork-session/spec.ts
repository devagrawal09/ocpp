import { createCommandSlice, event } from "@specter-ts/spec"

const identity = (sessionID: string, extra: Record<string, unknown> = {}) => ({
  sessionID,
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
  ...extra,
})
const created = (sessionID: string, extra: Record<string, unknown> = {}) =>
  event("session-created", identity(sessionID, extra))
const deleted = (sessionID: string) => event("session-deleted", { sessionID })

// The child's identity, as the host derives it from its parent: a new ID and
// slug, the parent's place and selections, and a fork title.
const child = identity("ses_2", { slug: "calm-heron", title: "Plan (fork #1)" })
const boundary = { type: "through", messageID: "msg_3" }
const instructions = { "builtin/agents": "a".repeat(64) }

export const forkSessionSpec = createCommandSlice("forkSession")
  .description(
    "Forks a live Session: the child's creation and the fork are recorded in one commit, so the child exists exactly when its fork does. The host resolves the boundary to a message of the parent's history and chooses the child's identity; the fork's projection copies the history.",
  )
  .scenarios(
    {
      description: "The child is created and forked from its parent at the boundary, in one commit.",
      given: [created("ses_1", { title: "Plan" })],
      when: { session: child, parentID: "ses_1", boundary },
      expect: [
        created("ses_2", { slug: "calm-heron", title: "Plan (fork #1)" }),
        event("session-forked", {
          sessionID: "ses_2",
          parentID: "ses_1",
          boundary,
        }),
      ],
    },
    {
      description: "The child adopts the parent's newest instruction values and entries, recorded with the fork.",
      given: [created("ses_1")],
      when: {
        session: child,
        parentID: "ses_1",
        boundary: { type: "before", messageID: "msg_3" },
        instructions,
        instructionEntries: [{ key: "ticket", value: { id: 42 }, removed: false }],
      },
      expect: [
        created("ses_2", { slug: "calm-heron", title: "Plan (fork #1)" }),
        event("session-forked", {
          sessionID: "ses_2",
          parentID: "ses_1",
          boundary: { type: "before", messageID: "msg_3" },
          instructions,
          instructionEntries: [{ key: "ticket", value: { id: 42 }, removed: false }],
        }),
      ],
    },
    {
      description: "A fork of a fork forks the middle Session like any other.",
      given: [created("ses_1"), created("ses_2")],
      when: { session: identity("ses_3"), parentID: "ses_2", boundary },
      expect: [created("ses_3"), event("session-forked", { sessionID: "ses_3", parentID: "ses_2", boundary })],
    },
    {
      description: "Forking an unknown Session is refused.",
      given: [],
      when: { session: child, parentID: "ses_missing", boundary },
      expect: [],
      reject: { reason: "Session not found" },
    },
    {
      description: "Forking a deleted Session is refused.",
      given: [created("ses_1"), deleted("ses_1")],
      when: { session: child, parentID: "ses_1", boundary },
      expect: [],
      reject: { reason: "Session deleted" },
    },
    {
      description: "The child's ID must be new: one a live or deleted Session had is refused.",
      given: [created("ses_1"), created("ses_2"), deleted("ses_2")],
      when: { session: child, parentID: "ses_1", boundary },
      expect: [],
      reject: { reason: "Session already exists" },
    },
  )

export default forkSessionSpec
