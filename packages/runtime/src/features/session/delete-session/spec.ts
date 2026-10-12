import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const started = event("session-execution-started", { sessionID: "ses_1" })
const succeeded = event("session-execution-settled", { sessionID: "ses_1", outcome: "succeeded" })
const interrupted = event("session-execution-settled", { sessionID: "ses_1", outcome: "interrupted", reason: "user" })
const stepStarted = event("session-step-started", {
  sessionID: "ses_1",
  assistantMessageID: "msg_2",
  agent: "build",
  model: { id: "scripted", providerID: "test" },
})
const stepAborted = event("session-step-settled", {
  sessionID: "ses_1",
  assistantMessageID: "msg_2",
  outcome: "failed",
  error: { type: "aborted", message: "Step interrupted" },
})
const requested = (id: string) =>
  event("session-tool-requested", {
    sessionID: "ses_1",
    assistantMessageID: "msg_2",
    id,
    name: "execute",
    input: { code: "x" },
    executed: false,
  })
const toolSettled = (id: string) =>
  event("session-tool-settled", {
    sessionID: "ses_1",
    assistantMessageID: "msg_2",
    id,
    outcome: "succeeded",
    content: [{ type: "text", text: "ok" }],
    executed: false,
  })
const toolAborted = (id: string) =>
  event("session-tool-settled", {
    sessionID: "ses_1",
    assistantMessageID: "msg_2",
    id,
    outcome: "failed",
    error: { type: "aborted", message: "Tool execution interrupted: execute" },
    executed: false,
  })
const enqueued = (inboxID: string) =>
  event("session-inbox-enqueued", {
    sessionID: "ses_1",
    inboxID,
    item: { type: "user", payload: { text: inboxID }, delivery: "steer" },
  })
const delivered = (inboxID: string) => event("session-inbox-delivered", { sessionID: "ses_1", inboxID })
const cancelled = (inboxID: string) => event("session-inbox-cancelled", { sessionID: "ses_1", inboxID })
const admitted = (executionID: string) =>
  event("session-codemode-execution-admitted", {
    sessionID: "ses_1",
    executionID,
    assistantMessageID: "msg_2",
    toolCallID: `call_${executionID}`,
    program: { version: 1, source: "return 1" },
    snapshot: [],
    reserved: [],
  })

const marker = (notificationID: string) =>
  event("session-background-started", {
    notificationID,
    sessionID: "ses_1",
    jobID: `job_${notificationID}`,
    recovery: { kind: "shell", sessionID: "ses_1", shellID: "sh_1", command: "sleep 60" },
  })

export const deleteSessionSpec = createCommandSlice("deleteSession")
  .description(
    "Deletes a Session. Nothing of it runs or waits afterwards: in the same commit, an active execution is interrupted as the user's interruption settles it (its open tool calls and in-flight step aborted), every input still pending is cancelled, so nothing wakes it again, and every Code Mode execution still admitted or running fails, and every background job marker it owns completes. Its deletion is the tombstone its purge keeps. The host deletes its children first.",
  )
  .scenarios(
    {
      description: "An idle Session with nothing pending is deleted.",
      given: [created, started, succeeded],
      when: { sessionID: "ses_1" },
      expect: [deleted],
    },
    {
      description: "Every input still pending is cancelled first, in admission order.",
      given: [
        created,
        enqueued("msg_1"),
        delivered("msg_1"),
        enqueued("msg_3"),
        enqueued("msg_4"),
        cancelled("msg_4"),
        enqueued("msg_5"),
      ],
      when: { sessionID: "ses_1" },
      expect: [cancelled("msg_3"), cancelled("msg_5"), deleted],
    },
    {
      description: "An active execution between steps is interrupted in the same commit.",
      given: [created, started],
      when: { sessionID: "ses_1" },
      expect: [interrupted, deleted],
    },
    {
      description:
        "An execution in the middle of a step settles its open tool calls and the step as aborted, then is interrupted; settled calls are left alone.",
      given: [
        created,
        enqueued("msg_1"),
        started,
        delivered("msg_1"),
        stepStarted,
        requested("call_1"),
        requested("call_2"),
        toolSettled("call_1"),
        enqueued("msg_3"),
      ],
      when: { sessionID: "ses_1" },
      expect: [toolAborted("call_2"), stepAborted, interrupted, cancelled("msg_3"), deleted],
    },
    {
      description: "A settled step leaves nothing open.",
      given: [
        created,
        started,
        stepStarted,
        event("session-step-settled", {
          sessionID: "ses_1",
          assistantMessageID: "msg_2",
          outcome: "succeeded",
          finish: "stop",
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        }),
      ],
      when: { sessionID: "ses_1" },
      expect: [interrupted, deleted],
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: { sessionID: "ses_1" },
      expect: [],
      reject: { code: "session-not-found" },
    },
    {
      description: "A Session is deleted once.",
      given: [created, deleted],
      when: { sessionID: "ses_1" },
      expect: [],
      reject: { code: "session-deleted" },
    },
    {
      description: "A Code Mode execution still admitted or running ends with its Session, in admission order.",
      given: [
        created,
        admitted("exe_1"),
        admitted("exe_2"),
        admitted("exe_3"),
        event("session-codemode-execution-settled", { sessionID: "ses_1", executionID: "exe_2", outcome: "finished" }),
        event("session-codemode-execution-discarded", { sessionID: "ses_1", executionID: "exe_3" }),
      ],
      when: { sessionID: "ses_1" },
      expect: [
        event("session-codemode-execution-settled", {
          sessionID: "ses_1",
          executionID: "exe_1",
          outcome: "failed",
          error: "The Session was deleted; nothing was saved.",
        }),
        deleted,
      ],
    },
    {
      description:
        "A background job marker it owns completes with it, in start order: nothing would deliver its notification.",
      given: [
        created,
        marker("msg_n1"),
        marker("msg_n2"),
        marker("msg_n3"),
        event("session-background-completed", { notificationID: "msg_n2", sessionID: "ses_1" }),
        marker("msg_n1"),
      ],
      when: { sessionID: "ses_1" },
      expect: [
        event("session-background-completed", { notificationID: "msg_n1", sessionID: "ses_1" }),
        event("session-background-completed", { notificationID: "msg_n3", sessionID: "ses_1" }),
        deleted,
      ],
    },
  )

export default deleteSessionSpec
