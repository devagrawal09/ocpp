import { createCommandSlice, event } from "@specter-ts/spec"

import { sessionFacts } from "../../facts.ts"

// Tests set up history the runtime and OC++'s Commands would have recorded:
// any fact, as given, deciding nothing. Only a runtime made for tests
// registers this Command, so production cannot reach it.
type Fact = keyof typeof sessionFacts
const recordOne = (type: Fact) => ({
  description: `Records ${type} as the test gave it.`,
  given: [],
  when: { facts: [{ type, payload: sessionFacts[type] }] },
  expect: [event(type, sessionFacts[type])] as const,
})
const [first, ...rest] = (Object.keys(sessionFacts) as Fact[]).map(recordOne)
// A tuple, so the builder can take one scenario per fact as rest arguments.
const recorded = [first, ...rest] as [ReturnType<typeof recordOne>, ...ReturnType<typeof recordOne>[]]

export const recordHistorySpec = createCommandSlice("recordHistory")
  .description(
    "Tests only: records the facts a test gives, in order and as given, to set up history that Commands would have recorded. It decides nothing.",
  )
  .scenarios(...recorded, {
    description: "Several facts are one commit, in the order the test gave them.",
    given: [],
    when: {
      facts: [
        { type: "session-inbox-enqueued", payload: sessionFacts["session-inbox-enqueued"] },
        { type: "session-inbox-delivered", payload: sessionFacts["session-inbox-delivered"] },
      ],
    },
    expect: [
      event("session-inbox-enqueued", sessionFacts["session-inbox-enqueued"]),
      event("session-inbox-delivered", sessionFacts["session-inbox-delivered"]),
    ],
  })

export default recordHistorySpec
