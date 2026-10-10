import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const started = event("session-compaction-started", { sessionID: "ses_1", reason: "auto", recent: "Recent" })
const completed = { sessionID: "ses_1", reason: "auto", outcome: "completed", text: "Summary", recent: "Recent" }
const failed = {
  sessionID: "ses_1",
  reason: "manual",
  outcome: "failed",
  error: { type: "compaction.unavailable", message: "Nothing to compact yet" },
  inputID: "msg_1",
}
const interrupted = {
  sessionID: "ses_1",
  reason: "auto",
  outcome: "failed",
  error: { type: "compaction.interrupted", message: "Compaction was interrupted" },
}
const usage = { cost: 0.02, tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } }

export const settleCompactionSpec = createCommandSlice("settleCompaction")
  .description(
    "Settles a live Session's compaction: completed with its summary and the recent context it keeps, or failed. Only a compaction that started completes; one that could not start fails without a start, naming its input. What the compaction spent is recorded in the same commit, before its outcome.",
  )
  .scenarios(
    {
      description: "A started compaction completes with its summary.",
      given: [created, started],
      when: completed,
      expect: [event("session-compaction-settled", completed)],
    },
    {
      description: "What the compaction spent is recorded with its outcome, in one commit.",
      given: [created, started],
      when: { ...completed, usage },
      expect: [
        event("session-usage-recorded", { sessionID: "ses_1", source: "compaction", ...usage }),
        event("session-compaction-settled", completed),
      ],
    },
    {
      description: "A compaction that never started cannot complete.",
      given: [created],
      when: completed,
      expect: [],
      reject: { reason: "No compaction running" },
    },
    {
      description: "A completed compaction cannot complete again.",
      given: [created, started, event("session-compaction-settled", completed)],
      when: completed,
      expect: [],
      reject: { reason: "No compaction running" },
    },
    {
      description: "A compaction that could not start fails without a start.",
      given: [created],
      when: failed,
      expect: [event("session-compaction-settled", failed)],
    },
    {
      description: "A started compaction fails.",
      given: [created, started],
      when: interrupted,
      expect: [event("session-compaction-settled", interrupted)],
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: failed,
      expect: [],
      reject: { reason: "Session not found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, started, deleted],
      when: completed,
      expect: [],
      reject: { reason: "Session deleted" },
    },
  )

export default settleCompactionSpec
