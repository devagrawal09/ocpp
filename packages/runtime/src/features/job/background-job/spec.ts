import { createCommandSlice, event } from "@specter-ts/spec"

const recovery = { kind: "codemode", parentSessionID: "ses_1", assistantMessageID: "msg_1", toolCallID: "call_1" }
const started = event("session-background-started", {
  notificationID: "msg_n1",
  sessionID: "ses_1",
  jobID: "exe_1",
  recovery,
})
const settled = { outcome: "error", error: "All fibers interrupted without error" }
const shell = { kind: "shell", sessionID: "ses_2", shellID: "sh_1", command: "sleep 60" }

export const backgroundJobSpec = createCommandSlice("backgroundJob")
  .description(
    "Records that a recoverable job went to the background: until its notification is delivered, its marker tells a restart how to resume it. The marker names the Session its notification arrives in, which owns it; a deleted Session takes no marker. A job that ended before it went to the background records its outcome in the same commit, so its marker exists exactly when the job did. A resumed job goes to the background again under its notification.",
  )
  .scenarios(
    {
      description: "A running job goes to the background under its notification.",
      given: [],
      when: { notificationID: "msg_n1", jobID: "exe_1", recovery },
      expect: [started],
    },
    {
      description: "A job that already ended records its start and its outcome, in one commit.",
      given: [],
      when: { notificationID: "msg_n1", jobID: "exe_1", recovery, settled: { outcome: "completed", output: "done" } },
      expect: [
        started,
        event("session-background-settled", {
          notificationID: "msg_n1",
          sessionID: "ses_1",
          outcome: "completed",
          output: "done",
        }),
      ],
    },
    {
      description: "A job a restart resumed goes to the background again under the same notification.",
      given: [
        started,
        event("session-background-settled", { notificationID: "msg_n1", sessionID: "ses_1", ...settled }),
      ],
      when: { notificationID: "msg_n1", jobID: "exe_1", recovery },
      expect: [started],
    },
    {
      description: "A shell's marker is its own Session's.",
      given: [],
      when: { notificationID: "msg_n2", jobID: "job_1", recovery: shell },
      expect: [
        event("session-background-started", {
          notificationID: "msg_n2",
          sessionID: "ses_2",
          jobID: "job_1",
          recovery: shell,
        }),
      ],
    },
    {
      description: "A deleted Session's job is refused: nothing would deliver its notification.",
      given: [event("session-deleted", { sessionID: "ses_1" })],
      when: { notificationID: "msg_n1", jobID: "exe_1", recovery },
      expect: [],
      reject: { code: "session-deleted" },
    },
  )

export default backgroundJobSpec
