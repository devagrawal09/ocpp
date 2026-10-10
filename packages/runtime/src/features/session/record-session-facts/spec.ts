import { createCommandSlice, event } from "@specter-ts/spec"

import { decided, refusal } from "./decided.ts"
import { sessionFacts } from "../../facts.ts"

// The embedding host (OC++) decides some Session facts itself and records
// them here: they are stored as the host published them, in order, one commit
// per publication, and the host's projections run in the same transaction as
// the append. Dedicated Commands take them over family by family; a fact one
// of them decides is refused here.
type Fact = keyof typeof sessionFacts
const recordOne = (type: Fact) => ({
  description: `Records ${type} as the host published it.`,
  given: [],
  when: { facts: [{ type, payload: sessionFacts[type] }] },
  expect: [event(type, sessionFacts[type])] as const,
})
const refuseOne = (type: keyof typeof decided) => ({
  description: `Refuses ${type}: ${decided[type]} decides it.`,
  given: [],
  when: {
    facts: [
      { type: "kv-stored", payload: sessionFacts["kv-stored"] },
      { type, payload: sessionFacts[type] },
    ],
  },
  expect: [] as const,
  reject: { reason: refusal(type)! },
})
const [first, ...rest] = (Object.keys(sessionFacts) as Fact[]).filter((type) => !(type in decided)).map(recordOne)
// A tuple, so the builder can take one scenario per fact as rest arguments.
const recorded = [first, ...rest] as [ReturnType<typeof recordOne>, ...ReturnType<typeof recordOne>[]]
const refused = (Object.keys(decided) as (keyof typeof decided)[]).map(refuseOne)

export const recordSessionFactsSpec = createCommandSlice("recordSessionFacts")
  .description(
    "Records the facts an embedding host published, in order and as given, except those a Command of their own decides.",
  )
  .scenarios(...recorded, ...refused, {
    description: "A publication of several facts is one commit, in the order the host published them.",
    given: [],
    when: {
      facts: [
        { type: "kv-stored", payload: sessionFacts["kv-stored"] },
        { type: "kv-removed", payload: sessionFacts["kv-removed"] },
      ],
    },
    expect: [event("kv-stored", sessionFacts["kv-stored"]), event("kv-removed", sessionFacts["kv-removed"])],
  })

export default recordSessionFactsSpec
