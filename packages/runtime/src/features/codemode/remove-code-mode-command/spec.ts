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
const copied = event("session-codemode-notebook-copied", {
  sessionID: "ses_2",
  parentID: "ses_1",
  executions: ["exe_1"],
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
      given: [created(), defined(), created("ses_2"), copied],
      when: { ...when, sessionID: "ses_2" },
      expect: [event("session-codemode-command-removed", { ...when, sessionID: "ses_2" })],
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
