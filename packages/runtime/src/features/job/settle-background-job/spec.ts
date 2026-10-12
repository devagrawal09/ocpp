import { createCommandSlice, event } from "@specter-ts/spec"

const recovery = { kind: "shell", sessionID: "ses_1", shellID: "sh_1", command: "sleep 60" }
const started = event("session-background-started", {
  notificationID: "msg_n1",
  sessionID: "ses_1",
  jobID: "job_1",
  recovery,
})
const outcome = { notificationID: "msg_n1", outcome: "completed", output: "done" }
const settled = event("session-background-settled", { ...outcome, sessionID: "ses_1" })
const completed = event("session-background-completed", { notificationID: "msg_n1", sessionID: "ses_1" })

export const settleBackgroundJobSpec = createCommandSlice("settleBackgroundJob")
  .description(
    "Settles a background job's marker with how the job ended: completed with its output, or error or cancelled. Only a marker whose job runs settles, once per run.",
  )
  .scenarios(
    {
      description: "A running job's marker settles with its outcome.",
      given: [started],
      when: outcome,
      expect: [settled],
    },
    {
      description: "A job a restart resumed settles again.",
      given: [started, settled, started],
      when: outcome,
      expect: [settled],
    },
    {
      description: "A marker that settled is refused.",
      given: [started, settled],
      when: outcome,
      expect: [],
      reject: { code: "background-job-not-running" },
    },
    {
      description: "A notification without a marker is refused.",
      given: [],
      when: outcome,
      expect: [],
      reject: { code: "background-job-not-found" },
    },
    {
      description: "A completed marker is gone.",
      given: [started, completed],
      when: outcome,
      expect: [],
      reject: { code: "background-job-not-found" },
    },
    {
      description: "A deleted Session's marker is gone: its deletion completed it, and its tombstone forgets it.",
      given: [started, completed, event("session-deleted", { sessionID: "ses_1" })],
      when: outcome,
      expect: [],
      reject: { code: "background-job-not-found" },
    },
  )

export default settleBackgroundJobSpec
