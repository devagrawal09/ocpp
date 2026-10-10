import { createCommandSlice, event } from "@specter-ts/spec"

const created = event("session-created", {
  sessionID: "ses_1",
  projectID: "prj_1",
  location: { directory: "/gone" },
  slug: "brave-otter",
  version: "2",
})
const deleted = event("session-deleted", { sessionID: "ses_1" })
const destination = { location: { directory: "/tmp/ws" }, projectID: "prj_1", subpath: "app" }
const moved = event("session-moved", { sessionID: "ses_1", ...destination })
const enqueued = (inboxID: string, type: "move" | "user" = "move") =>
  event("session-inbox-enqueued", {
    sessionID: "ses_1",
    inboxID,
    item:
      type === "move"
        ? { type, payload: { location: { directory: `/elsewhere/${inboxID}` }, projectID: "prj_1" }, delivery: "steer" }
        : { type, payload: { text: "hello" }, delivery: "steer" },
  })
const delivered = (inboxID: string) => event("session-inbox-delivered", { sessionID: "ses_1", inboxID })
const cancelled = (inboxID: string) => event("session-inbox-cancelled", { sessionID: "ses_1", inboxID })

export const moveSessionSpec = createCommandSlice("moveSession")
  .description(
    "Moves a Session now, for one that cannot run where it is (its directory is gone). A move that can wait is admitted to the inbox as a control item instead (enqueueInput) and moves the Session when it is delivered. Moving now supersedes the moves waiting in the inbox: they are cancelled in the same commit.",
  )
  .scenarios(
    {
      description: "The Session moves to the destination at once.",
      given: [created],
      when: { sessionID: "ses_1", ...destination },
      expect: [moved],
    },
    {
      description: "Every move still waiting in the inbox is cancelled first, in admission order; other input stays.",
      given: [created, enqueued("msg_1"), enqueued("msg_2", "user"), enqueued("msg_3")],
      when: { sessionID: "ses_1", ...destination },
      expect: [cancelled("msg_1"), cancelled("msg_3"), moved],
    },
    {
      description: "A move that was delivered or cancelled is no longer waiting.",
      given: [created, enqueued("msg_1"), delivered("msg_1"), enqueued("msg_2"), cancelled("msg_2")],
      when: { sessionID: "ses_1", ...destination },
      expect: [moved],
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: { sessionID: "ses_1", ...destination },
      expect: [],
      reject: { reason: "Session not found" },
    },
    {
      description: "A deleted Session is refused.",
      given: [created, deleted],
      when: { sessionID: "ses_1", ...destination },
      expect: [],
      reject: { reason: "Session deleted" },
    },
  )

export default moveSessionSpec
