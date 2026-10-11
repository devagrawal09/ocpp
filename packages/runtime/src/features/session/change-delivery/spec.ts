import { createCommandSlice, event } from "@specter-ts/spec"

const created = (sessionID = "ses_1") =>
  event("session-created", {
    sessionID,
    projectID: "prj_1",
    location: { directory: "/tmp/ws" },
    slug: "brave-otter",
    version: "2",
  })

const enqueued = (inboxID: string, delivery: string, sessionID = "ses_1") =>
  event("session-inbox-enqueued", {
    sessionID,
    inboxID,
    item: { type: "user", payload: { text: "later" }, delivery },
  })
const changed = (inboxID: string, delivery: string) =>
  event("session-inbox-delivery-changed", {
    sessionID: "ses_1",
    inboxID,
    delivery,
  })

export const changeDeliverySpec = createCommandSlice("changeDelivery")
  .description(
    "Changes how a pending inbox item is delivered (session.md: steer and queue): a steered item enters history at the next step boundary, a queued one waits for idle.",
  )
  .scenarios(
    {
      description: "A queued item is steered.",
      given: [created(), enqueued("msg_1", "queue")],
      when: { sessionID: "ses_1", inboxID: "msg_1", delivery: "steer" },
      expect: [changed("msg_1", "steer")],
    },
    {
      description: "A steered item is queued.",
      given: [created(), enqueued("msg_1", "steer")],
      when: { sessionID: "ses_1", inboxID: "msg_1", delivery: "queue" },
      expect: [changed("msg_1", "queue")],
    },
    {
      description: "An item can change back after an earlier change.",
      given: [created(), enqueued("msg_1", "queue"), changed("msg_1", "steer")],
      when: { sessionID: "ses_1", inboxID: "msg_1", delivery: "queue" },
      expect: [changed("msg_1", "queue")],
    },
    {
      description: "An item already delivered that way is rejected.",
      given: [created(), enqueued("msg_1", "steer")],
      when: { sessionID: "ses_1", inboxID: "msg_1", delivery: "steer" },
      expect: [],
      reject: { code: "inbox-delivery-unchanged", message: "Inbox item already steer" },
    },
    {
      description: "Delivered input is no longer pending.",
      given: [
        created(),
        enqueued("msg_1", "queue"),
        event("session-inbox-delivered", {
          sessionID: "ses_1",
          inboxID: "msg_1",
        }),
      ],
      when: { sessionID: "ses_1", inboxID: "msg_1", delivery: "steer" },
      expect: [],
      reject: { code: "inbox-item-not-pending" },
    },
    {
      description: "Cancelled input is no longer pending.",
      given: [
        created(),
        enqueued("msg_1", "queue"),
        event("session-inbox-cancelled", {
          sessionID: "ses_1",
          inboxID: "msg_1",
        }),
      ],
      when: { sessionID: "ses_1", inboxID: "msg_1", delivery: "steer" },
      expect: [],
      reject: { code: "inbox-item-not-pending" },
    },
    {
      description: "An unknown item, or one admitted to another Session, is not found.",
      given: [created(), created("ses_2"), enqueued("msg_1", "queue", "ses_2")],
      when: { sessionID: "ses_1", inboxID: "msg_1", delivery: "steer" },
      expect: [],
      reject: { code: "inbox-item-not-found" },
    },
    {
      description: "An unknown Session is refused.",
      given: [],
      when: { sessionID: "ses_1", inboxID: "msg_1", delivery: "steer" },
      expect: [],
      reject: { code: "session-not-found" },
    },
    {
      description: "A deleted Session is refused; deleting it cancelled its pending input.",
      given: [
        created(),
        enqueued("msg_1", "queue"),
        event("session-inbox-cancelled", { sessionID: "ses_1", inboxID: "msg_1" }),
        event("session-deleted", { sessionID: "ses_1" }),
      ],
      when: { sessionID: "ses_1", inboxID: "msg_1", delivery: "steer" },
      expect: [],
      reject: { code: "session-deleted" },
    },
  )

export default changeDeliverySpec
