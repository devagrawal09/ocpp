import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const admitted = (sessionID = "ses_1") =>
  event("session-codemode-execution-admitted", {
    sessionID,
    executionID: "exe_1",
    assistantMessageID: "msg_1",
    toolCallID: "call_1",
    program: { version: 1, source: "const a = 1" },
    snapshot: [],
    reserved: ["a"],
  })
const start = { sessionID: "ses_1", assistantMessageID: "msg_1", id: "call_1", executionID: "exe_1" }
const started = event("session-codemode-started", start)

export const startCodeModeSpec = createCommandSlice("startCodeMode")
  .description(
    "Records in a live Session that an admitted Code Mode execution went to the background, for the call or the invocation that owns it: its result arrives later. An execution starts this way once.",
  )
  .scenarios(
    {
      description: "An admitted execution of the Session starts in the background.",
      given: [created, admitted()],
      when: start,
      expect: [started],
    },
    {
      description: "An execution that started already is refused.",
      given: [created, admitted(), started],
      when: start,
      expect: [],
      reject: { code: "code-mode-already-started" },
    },
    {
      description: "An execution another Session admitted is refused.",
      given: [created, admitted("ses_2")],
      when: start,
      expect: [],
      reject: { code: "execution-not-found" },
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: start,
      expect: [],
      reject: { code: "session-not-found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, admitted(), deleted],
      when: start,
      expect: [],
      reject: { code: "session-deleted" },
    },
  )

export default startCodeModeSpec
