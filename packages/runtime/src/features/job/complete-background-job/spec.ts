import { createCommandSlice, event } from "@specter-ts/spec"

const recovery = { kind: "shell", sessionID: "ses_1", shellID: "sh_1", command: "sleep 60" }
const started = event("session-background-started", { notificationID: "msg_n1", jobID: "job_1", recovery })
const completed = event("session-background-completed", { notificationID: "msg_n1" })

export const completeBackgroundJobSpec = createCommandSlice("completeBackgroundJob")
  .description(
    "Completes a background job's marker once its notification was delivered, or the job was discarded: nothing is left to recover, and the marker goes. Restart recovery completes the markers it settles.",
  )
  .scenarios(
    {
      description: "A marker completes, whatever its job's state.",
      given: [started],
      when: { notificationID: "msg_n1" },
      expect: [completed],
    },
    {
      description: "A notification without a marker is refused.",
      given: [],
      when: { notificationID: "msg_n1" },
      expect: [],
      reject: { reason: "Background job not found" },
    },
    {
      description: "A completed marker is gone.",
      given: [started, completed],
      when: { notificationID: "msg_n1" },
      expect: [],
      reject: { reason: "Background job not found" },
    },
  )

export default completeBackgroundJobSpec
