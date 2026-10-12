import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const succeeded = event("session-execution-settled", { sessionID: "ses_1", outcome: "succeeded" })
const shutdown = event("session-execution-settled", { sessionID: "ses_1", outcome: "interrupted", reason: "shutdown" })
const imported = event("session-imported", {
  sessionID: "ses_1",
  messages: [],
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
  time: { created: 1, updated: 2, idle: 1200, viewed: 1100 },
})
const viewed = (idle: number) => event("session-viewed", { sessionID: "ses_1", idle })
const view = (idle: number) => ({ sessionID: "ses_1", idle })

// A Given fact at position N is recorded N seconds after the epoch, so a Session whose execution settled second
// went idle at 2000.
export const viewSessionSpec = createCommandSlice("viewSession")
  .description(
    "Records that a viewer saw a live Session as of an idle time: the time its execution last settled, which the Session's facts carry. A viewer cannot have seen an idle time the Session has not reached, and one it saw already is not recorded again.",
  )
  .scenarios(
    {
      description: "A viewer saw the Session as of the time its execution settled.",
      given: [created, succeeded],
      when: view(2000),
      expect: [viewed(2000)],
    },
    {
      description: "A view of an earlier idle time is recorded: the later one stays unread.",
      given: [created, succeeded, succeeded],
      when: view(2000),
      expect: [viewed(2000)],
    },
    {
      description: "A Session whose execution never settled has no idle time to view.",
      given: [created],
      when: view(1000),
      expect: [],
      reject: { code: "idle-not-reached" },
    },
    {
      description: "A viewer cannot have seen an idle time the Session has not reached.",
      given: [created, succeeded],
      when: view(3000),
      expect: [],
      reject: { code: "idle-not-reached" },
    },
    {
      description: "An idle time viewed already is not viewed again.",
      given: [created, succeeded, viewed(2000)],
      when: view(2000),
      expect: [],
      reject: { code: "already-viewed" },
    },
    {
      description: "A newer idle time is viewed after an older one.",
      given: [created, succeeded, viewed(2000), succeeded],
      when: view(4000),
      expect: [viewed(4000)],
    },
    {
      description: "A shutdown leaves the Session idle as it was.",
      given: [created, succeeded, shutdown],
      when: view(3000),
      expect: [],
      reject: { code: "idle-not-reached" },
    },
    {
      description: "An imported Session is idle and viewed as its export says.",
      given: [created, imported],
      when: view(1200),
      expect: [viewed(1200)],
    },
    {
      description: "An imported Session's view stands.",
      given: [created, imported],
      when: view(1100),
      expect: [],
      reject: { code: "already-viewed" },
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: view(1000),
      expect: [],
      reject: { code: "session-not-found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, deleted],
      when: view(1000),
      expect: [],
      reject: { code: "session-deleted" },
    },
  )

export default viewSessionSpec
