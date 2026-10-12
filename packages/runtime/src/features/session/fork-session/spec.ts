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
const childCreated = created("ses_2", { slug: "calm-heron", title: "Plan (fork #1)" })
const boundary = { type: "through", messageID: "msg_3" }
const forked = event("session-forked", { sessionID: "ses_2", parentID: "ses_1", boundary })
const instructions = { "builtin/agents": "a".repeat(64) }

// The parent's settled messages through the boundary, as its projection holds
// them. Their encoded sizes are 82, 77, 171 and 73 bytes.
type Message = { type: string; seq: number; created: number; updated: number; data: Record<string, string> }
const first: Message = { type: "user", seq: 1, created: 1, updated: 1, data: { text: "Plan the release" } }
const reply: Message = { type: "assistant", seq: 4, created: 2, updated: 3, data: { finish: "stop" } }
const long: Message = { type: "synthetic", seq: 5, created: 3, updated: 3, data: { text: "x".repeat(100) } }
const last: Message = { type: "user", seq: 7, created: 4, updated: 4, data: { text: "Ship it" } }
const copiedHistory = (...messages: Message[]) => event("session-history-copied", { sessionID: "ses_2", messages })

// The parent's notebook through the boundary: a value, a command and an event
// it handles, and a command and an event whose handler the history did not
// copy.
const report = { value: { kind: "function", source: "function report() {}" }, executionID: "exe_1", seq: 4 }
const deploy = { description: "Deploys the app", handler: "report", created: 1, updated: 2 }
const nightly = {
  description: "Reports nightly",
  schedule: { every: "1d" },
  handler: "report",
  created: 1,
  updated: 5,
}
const notebook = {
  values: { report },
  commands: { deploy, publish: { ...deploy, handler: "publish" } },
  events: { nightly, hourly: { ...nightly, handler: "later" } },
}

export const forkSessionSpec = createCommandSlice("forkSession")
  .description(
    "Forks a live Session: the child's creation and the fork are recorded in one commit, so the child exists exactly when its fork does. The host resolves the boundary to a message of the parent's history and chooses the child's identity, and gives what the child inherits of its parent's projection: its settled messages through the boundary, the notebook values they saved with the parent's commands and events, its newest instruction values with the values they refer to, its instruction entries and its tool list. The fork records all of it, before session-forked, so nothing of the child reads its parent's facts: its history in pages of at most the bytes the host gives, and its notebook with the commands and events whose handler it holds.",
  )
  .scenarios(
    {
      description: "The child is created and forked from its parent at the boundary, in one commit.",
      given: [created("ses_1", { title: "Plan" })],
      when: { session: child, parentID: "ses_1", boundary },
      expect: [childCreated, forked],
    },
    {
      description:
        "The child's history copies the parent's messages in pages: as many as fit in a page's bytes, in order, and one larger than a page in a page of its own.",
      given: [created("ses_1", { title: "Plan" })],
      when: {
        session: child,
        parentID: "ses_1",
        boundary,
        history: { messages: [first, reply, long, last], pageBytes: 160 },
      },
      expect: [childCreated, copiedHistory(first, reply), copiedHistory(long), copiedHistory(last), forked],
    },
    {
      description:
        "The child's notebook copies the values the host found through the boundary, with the commands and events those values handle.",
      given: [created("ses_1", { title: "Plan" })],
      when: { session: child, parentID: "ses_1", boundary, notebook },
      expect: [
        childCreated,
        event("session-codemode-notebook-copied", {
          sessionID: "ses_2",
          values: { report },
          commands: { deploy },
          events: { nightly },
        }),
        forked,
      ],
    },
    {
      description: "A notebook without values copies nothing: no command or event has its handler.",
      given: [created("ses_1", { title: "Plan" })],
      when: { session: child, parentID: "ses_1", boundary, notebook: { ...notebook, values: {} } },
      expect: [childCreated, forked],
    },
    {
      description:
        "The child adopts the parent's newest instruction values, storing the values they refer to, its entries and its tool list, recorded with the fork.",
      given: [created("ses_1")],
      when: {
        session: child,
        parentID: "ses_1",
        boundary: { type: "before", messageID: "msg_3" },
        instructions,
        blobs: { ["a".repeat(64)]: "Use the agents in AGENTS.md" },
        instructionEntries: [{ key: "ticket", value: { id: 42 }, removed: false }],
        tools: ["glob"],
      },
      expect: [
        childCreated,
        event("session-instruction-blobs-stored", {
          sessionID: "ses_2",
          blobs: { ["a".repeat(64)]: "Use the agents in AGENTS.md" },
        }),
        event("session-forked", {
          sessionID: "ses_2",
          parentID: "ses_1",
          boundary: { type: "before", messageID: "msg_3" },
          instructions,
          instructionEntries: [{ key: "ticket", value: { id: 42 }, removed: false }],
          tools: ["glob"],
        }),
      ],
    },
    {
      description:
        "Everything the child inherits precedes its fork, in one commit: its instruction values, its history, then its notebook.",
      given: [created("ses_1")],
      when: {
        session: child,
        parentID: "ses_1",
        boundary,
        instructions,
        blobs: { ["a".repeat(64)]: "Use the agents in AGENTS.md" },
        history: { messages: [first, reply], pageBytes: 1024 },
        notebook,
      },
      expect: [
        childCreated,
        event("session-instruction-blobs-stored", {
          sessionID: "ses_2",
          blobs: { ["a".repeat(64)]: "Use the agents in AGENTS.md" },
        }),
        copiedHistory(first, reply),
        event("session-codemode-notebook-copied", {
          sessionID: "ses_2",
          values: { report },
          commands: { deploy },
          events: { nightly },
        }),
        event("session-forked", { sessionID: "ses_2", parentID: "ses_1", boundary, instructions }),
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
      reject: { code: "session-not-found" },
    },
    {
      description: "Forking a deleted Session is refused.",
      given: [created("ses_1"), deleted("ses_1")],
      when: { session: child, parentID: "ses_1", boundary },
      expect: [],
      reject: { code: "session-deleted" },
    },
    {
      description: "The child's ID must be new: one a live or deleted Session had is refused.",
      given: [created("ses_1"), created("ses_2"), deleted("ses_2")],
      when: { session: child, parentID: "ses_1", boundary },
      expect: [],
      reject: { code: "session-already-exists" },
    },
  )

export default forkSessionSpec
