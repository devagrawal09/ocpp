import { createCommandSlice, event } from "@specter-ts/spec"

const recovery = { kind: "codemode", parentSessionID: "ses_1", assistantMessageID: "msg_1", toolCallID: "call_1" }
const started = event("session-background-started", { notificationID: "msg_n1", jobID: "exe_1", recovery })
const settled = { outcome: "error", error: "All fibers interrupted without error" }

export const backgroundJobSpec = createCommandSlice("backgroundJob")
  .description(
    "Records that a recoverable job went to the background: until its notification is delivered, its marker tells a restart how to resume it. A job that ended before it went to the background records its outcome in the same commit, so its marker exists exactly when the job did. A resumed job goes to the background again under its notification.",
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
        event("session-background-settled", { notificationID: "msg_n1", outcome: "completed", output: "done" }),
      ],
    },
    {
      description: "A job a restart resumed goes to the background again under the same notification.",
      given: [started, event("session-background-settled", { notificationID: "msg_n1", ...settled })],
      when: { notificationID: "msg_n1", jobID: "exe_1", recovery },
      expect: [started],
    },
  )

export default backgroundJobSpec
