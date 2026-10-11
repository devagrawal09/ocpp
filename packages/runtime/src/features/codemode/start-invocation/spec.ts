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
    assistantMessageID: "msg_inv",
    toolCallID: "msg_inv",
    program: { version: 1, source: "return deploy(input)" },
    snapshot: ["deploy"],
    reserved: [],
  })
const invocation = {
  sessionID: "ses_1",
  executionID: "exe_1",
  trigger: { type: "command", name: "deploy", text: "now" },
  handler: "deploy",
  input: { text: "now", command: "deploy" },
}
const started = event("session-invocation-started", invocation)

export const startInvocationSpec = createCommandSlice("startInvocation")
  .description(
    "Records in a live Session that a command or an event ran a notebook function outside the model, as the invocation message that owns its admitted Code Mode execution. The host names the message's ID through the fact's. An execution has one invocation.",
  )
  .scenarios(
    {
      description: "An admitted execution of the Session starts its invocation.",
      given: [created, admitted()],
      when: invocation,
      expect: [started],
    },
    {
      description: "An execution that has its invocation is refused.",
      given: [created, admitted(), started],
      when: invocation,
      expect: [],
      reject: { code: "invocation-already-started" },
    },
    {
      description: "An execution another Session admitted is refused.",
      given: [created, admitted("ses_2")],
      when: invocation,
      expect: [],
      reject: { code: "execution-not-found" },
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: invocation,
      expect: [],
      reject: { code: "session-not-found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, admitted(), deleted],
      when: invocation,
      expect: [],
      reject: { code: "session-deleted" },
    },
  )

export default startInvocationSpec
