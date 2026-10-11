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
const when = { sessionID: "ses_1", name: "deploy", description: "Deploy the app", handler: "deploy" }

export const defineCodeModeCommandSpec = createCommandSlice("defineCodeModeCommand")
  .description(
    "Defines a slash command of a live Session that calls a notebook function; defining an existing one replaces it. The host checks that the handler names a function the notebook holds, or one a running execution will save.",
  )
  .scenarios(
    {
      description: "A live Session's command is defined.",
      given: [created()],
      when,
      expect: [event("session-codemode-command-defined", when)],
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when,
      expect: [],
      reject: { reason: "Session not found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created(), deleted],
      when,
      expect: [],
      reject: { reason: "Session deleted" },
    },
  )

export default defineCodeModeCommandSpec
