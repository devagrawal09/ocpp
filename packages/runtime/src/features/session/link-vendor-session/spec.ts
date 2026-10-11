import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/tmp/ws" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const bound = event("session-external-bound", { sessionID: "ses_1", provider: "claude", directory: "/tmp/ws" })
const linked = (vendorSessionID = "vendor_1") =>
  event("session-external-linked", { sessionID: "ses_1", vendorSessionID })

export const linkVendorSessionSpec = createCommandSlice("linkVendorSession")
  .description(
    "Links a live Session bound to an external agent to the vendor session that continues it. Linking the vendor session it has changes nothing; binding again unlinks it.",
  )
  .scenarios(
    {
      description: "A bound Session is linked to its vendor session.",
      given: [created, bound],
      when: { sessionID: "ses_1", vendorSessionID: "vendor_1" },
      expect: [linked()],
    },
    {
      description: "A new vendor session replaces the linked one.",
      given: [created, bound, linked()],
      when: { sessionID: "ses_1", vendorSessionID: "vendor_2" },
      expect: [linked("vendor_2")],
    },
    {
      description: "The vendor session the Session has is refused: there is nothing to change.",
      given: [created, bound, linked()],
      when: { sessionID: "ses_1", vendorSessionID: "vendor_1" },
      expect: [],
      reject: { code: "vendor-session-already-linked" },
    },
    {
      description: "Binding again unlinks the vendor session, so linking it again records it.",
      given: [created, bound, linked(), bound],
      when: { sessionID: "ses_1", vendorSessionID: "vendor_1" },
      expect: [linked()],
    },
    {
      description: "A Session that no external agent runs is refused.",
      given: [created],
      when: { sessionID: "ses_1", vendorSessionID: "vendor_1" },
      expect: [],
      reject: { code: "external-agent-not-bound" },
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: { sessionID: "ses_1", vendorSessionID: "vendor_1" },
      expect: [],
      reject: { code: "session-not-found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, bound, deleted],
      when: { sessionID: "ses_1", vendorSessionID: "vendor_1" },
      expect: [],
      reject: { code: "session-deleted" },
    },
  )

export default linkVendorSessionSpec
