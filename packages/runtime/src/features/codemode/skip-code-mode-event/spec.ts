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
// A fork's notebook copy: the value its parent's event calls, and that event
// when the fork copied the value it handles.
const copied = (withEvent: boolean) =>
  event("session-codemode-notebook-copied", {
    sessionID: "ses_2",
    values: { report: { value: { function: "report" }, executionID: "exe_1", seq: 2 } },
    commands: {},
    events: withEvent
      ? {
          nightly: {
            description: "Nightly report",
            schedule: { every: "1d" },
            handler: "report",
            created: 1,
            updated: 1,
          },
        }
      : {},
  })
const defined = (sessionID = "ses_1") =>
  event("session-codemode-event-defined", {
    sessionID,
    name: "nightly",
    description: "Nightly report",
    schedule: { every: "1d" },
    handler: "report",
    time: 1,
    next: 86400001,
  })
const removed = event("session-codemode-event-removed", { sessionID: "ses_1", name: "nightly" })
const when = { sessionID: "ses_1", name: "nightly", at: 86400001 }

export const skipCodeModeEventSpec = createCommandSlice("skipCodeModeEvent")
  .description("Records a firing of a live Session's event skipped because the previous one still runs.")
  .scenarios(
    {
      description: "An event the Session defined records a skipped firing.",
      given: [created(), defined()],
      when,
      expect: [event("session-codemode-event-skipped", when)],
    },
    {
      description: "A fork's event, copied with its notebook, is the fork's own.",
      given: [created(), defined(), created("ses_2"), copied(true)],
      when: { ...when, sessionID: "ses_2" },
      expect: [event("session-codemode-event-skipped", { ...when, sessionID: "ses_2" })],
    },
    {
      description: "A fork has the events its copy carries, not its parent's: one the copy left out is not the fork's.",
      given: [created(), defined(), created("ses_2"), copied(false)],
      when: { ...when, sessionID: "ses_2" },
      expect: [],
      reject: { code: "event-not-found" },
    },
    {
      description: "An event the Session does not have is refused, and the host answers as done.",
      given: [created(), defined(), removed],
      when,
      expect: [],
      reject: { code: "event-not-found" },
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

export default skipCodeModeEventSpec
