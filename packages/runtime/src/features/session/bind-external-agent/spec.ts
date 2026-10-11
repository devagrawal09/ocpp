import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const bound = (provider = "claude", directory = "/tmp/ws") =>
  event("session-external-bound", { sessionID: "ses_1", provider, directory })

export const bindExternalAgentSpec = createCommandSlice("bindExternalAgent")
  .description(
    "Binds a live Session to the external agent (vendor) that runs it, in a directory. Binding to another vendor or directory starts a new vendor session; binding to the same one changes nothing.",
  )
  .scenarios(
    {
      description: "A Session is bound to its vendor and directory.",
      given: [created],
      when: { sessionID: "ses_1", provider: "claude", directory: "/tmp/ws" },
      expect: [bound()],
    },
    {
      description: "Another vendor binds again.",
      given: [created, bound()],
      when: { sessionID: "ses_1", provider: "codex", directory: "/tmp/ws" },
      expect: [bound("codex")],
    },
    {
      description: "Another directory binds again.",
      given: [created, bound()],
      when: { sessionID: "ses_1", provider: "claude", directory: "/tmp/other" },
      expect: [bound("claude", "/tmp/other")],
    },
    {
      description: "The binding the Session has is refused: there is nothing to change.",
      given: [created, bound()],
      when: { sessionID: "ses_1", provider: "claude", directory: "/tmp/ws" },
      expect: [],
      reject: { reason: "External agent already bound" },
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: { sessionID: "ses_1", provider: "claude", directory: "/tmp/ws" },
      expect: [],
      reject: { reason: "Session not found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, deleted],
      when: { sessionID: "ses_1", provider: "claude", directory: "/tmp/ws" },
      expect: [],
      reject: { reason: "Session deleted" },
    },
  )

export default bindExternalAgentSpec
