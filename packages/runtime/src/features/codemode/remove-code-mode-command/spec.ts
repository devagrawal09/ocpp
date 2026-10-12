import { createCommandSlice, event } from "@specter-ts/spec"

const created = (sessionID = "ses_1") =>
  event("session-created", {
    sessionID,
    projectID: "prj_1",
    location: { directory: "/tmp/ws" },
    slug: sessionID,
    version: "2",
  })
const deleted = event("session-deleted", { sessionID: "ses_1" })
// A fork's notebook copy: the value its parent's command calls, and that
// command when the fork copied the value it handles.
const copied = (withCommand: boolean) =>
  event("session-codemode-notebook-copied", {
    sessionID: "ses_2",
    values: { deploy: { value: { function: "deploy" }, executionID: "exe_1", seq: 2 } },
    commands: withCommand
      ? { deploy: { description: "Deploy the app", handler: "deploy", created: 1, updated: 1 } }
      : {},
    events: {},
  })
const defined = (sessionID = "ses_1") =>
  event("session-codemode-command-defined", {
    sessionID,
    name: "deploy",
    description: "Deploy the app",
    handler: "deploy",
  })
const removed = event("session-codemode-command-removed", { sessionID: "ses_1", name: "deploy" })
const when = { sessionID: "ses_1", name: "deploy" }

export const removeCodeModeCommandSpec = createCommandSlice("removeCodeModeCommand")
  .description(
    "Removes a slash command a live Session defined, or that its fork copied. A command the Session does not have records nothing.",
  )
  .scenarios(
    {
      description: "A command the Session defined is removed.",
      given: [created(), defined()],
      when,
      expect: [event("session-codemode-command-removed", when)],
    },
    {
      description: "A fork's command, copied with its notebook, is the fork's own.",
      given: [created(), defined(), created("ses_2"), copied(true)],
      when: { ...when, sessionID: "ses_2" },
      expect: [event("session-codemode-command-removed", { ...when, sessionID: "ses_2" })],
    },
    {
      description:
        "A fork has the commands its copy carries, not its parent's: one the copy left out is not the fork's.",
      given: [created(), defined(), created("ses_2"), copied(false)],
      when: { ...when, sessionID: "ses_2" },
      expect: [],
      reject: { code: "command-not-found" },
    },
    {
      description: "A command the Session does not have is refused, and the host answers as done.",
      given: [created(), defined(), removed],
      when,
      expect: [],
      reject: { code: "command-not-found" },
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when,
      expect: [],
      reject: { code: "session-not-found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created(), defined(), deleted],
      when,
      expect: [],
      reject: { code: "session-deleted" },
    },
  )

export default removeCodeModeCommandSpec
