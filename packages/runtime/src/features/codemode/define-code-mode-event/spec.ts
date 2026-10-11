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
const when = {
  sessionID: "ses_1",
  name: "nightly",
  description: "Nightly report",
  schedule: { every: "1d" },
  handler: "report",
  time: 1,
  next: 86400001,
}

export const defineCodeModeEventSpec = createCommandSlice("defineCodeModeEvent")
  .description(
    "Defines a scheduled event of a live Session that calls a notebook function; defining an existing one replaces it and starts it over. The host checks the name, the schedule and the handler, and that the Session is not a subagent's.",
  )
  .scenarios(
    {
      description: "A live Session's event is defined.",
      given: [created()],
      when,
      expect: [event("session-codemode-event-defined", when)],
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
      given: [created(), deleted],
      when,
      expect: [],
      reject: { code: "session-deleted" },
    },
  )

export default defineCodeModeEventSpec
