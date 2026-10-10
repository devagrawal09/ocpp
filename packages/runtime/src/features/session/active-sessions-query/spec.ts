import { createQuerySlice, event } from "@specter-ts/spec"

const started = (sessionID: string) => event("session-execution-started", { sessionID })
const settled = (sessionID: string) => event("session-execution-settled", { sessionID, outcome: "succeeded" })
const interrupted = (sessionID: string) =>
  event("session-execution-settled", { sessionID, outcome: "interrupted", reason: "shutdown" })

export const activeSessionsSpec = createQuerySlice("activeSessions")
  .description(
    "Lists the Sessions with an active execution, whichever process started it: what a host reports as running and checks before changing a Session's history.",
  )
  .scenarios(
    {
      description: "No Session is active before an execution starts.",
      given: [],
      when: {},
      expect: { sessionIDs: [] },
    },
    {
      description: "A Session is active from its execution's start until it settles.",
      given: [started("ses_2"), started("ses_1"), settled("ses_2")],
      when: {},
      expect: { sessionIDs: ["ses_1"] },
    },
    {
      description:
        "An execution a stopped process left running is still active: it settles only when the runtime settles it.",
      given: [started("ses_1"), interrupted("ses_1"), started("ses_1")],
      when: {},
      expect: { sessionIDs: ["ses_1"] },
    },
    {
      description: "Sessions are listed in ID order.",
      given: [started("ses_b"), started("ses_a")],
      when: {},
      expect: { sessionIDs: ["ses_a", "ses_b"] },
    },
  )

export default activeSessionsSpec
