import { createCommandSlice, event } from "@specter-ts/spec"

const created = (title?: string) =>
  event("session-created", {
    sessionID: "ses_1",
    projectID: "prj_1",
    location: { directory: "/tmp/ws" },
    slug: "brave-otter",
    version: "2",
    ...(title === undefined ? {} : { title }),
  })
const deleted = event("session-deleted", { sessionID: "ses_1" })
const renamed = (title: string) => event("session-renamed", { sessionID: "ses_1", title })

export const renameSessionSpec = createCommandSlice("renameSession")
  .description(
    "Renames a live Session. A title the host generated replaces the title it was generated for, and only while the Session still has it: a rename that landed meanwhile wins.",
  )
  .scenarios(
    {
      description: "A live Session takes the new title.",
      given: [created()],
      when: { sessionID: "ses_1", title: "Fix the build" },
      expect: [renamed("Fix the build")],
    },
    {
      description: "A generated title replaces the untitled Session's missing title.",
      given: [created()],
      when: { sessionID: "ses_1", title: "Fix the build", replacing: {} },
      expect: [renamed("Fix the build")],
    },
    {
      description: "A generated title replaces the title it was generated for.",
      given: [created("New session"), renamed("Old title")],
      when: { sessionID: "ses_1", title: "Fix the build", replacing: { title: "Old title" } },
      expect: [renamed("Fix the build")],
    },
    {
      description: "A generated title does not replace a title the Session took meanwhile.",
      given: [created(), renamed("Manual title")],
      when: { sessionID: "ses_1", title: "Fix the build", replacing: {} },
      expect: [],
      reject: { code: "title-changed" },
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: { sessionID: "ses_1", title: "Fix the build" },
      expect: [],
      reject: { code: "session-not-found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created(), deleted],
      when: { sessionID: "ses_1", title: "Fix the build" },
      expect: [],
      reject: { code: "session-deleted" },
    },
  )

export default renameSessionSpec
