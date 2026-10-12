import { createReactionSlice, event } from "@specter-ts/spec"

const deleted = (sessionID: string) => event("session-deleted", { sessionID })
const purge = (sessionID: string) => ({
  type: "purgeSession",
  payload: { sessionID },
})

export const purgeSessionSpec = createReactionSlice("purgeSession")
  .description(
    "Purges a deleted Session's facts from the log, and those of the aggregates it owns (its inbox, executions, Code Mode runs and calls, background job markers, external agent links), but for its deletion: the tombstone every Slice folds to keep refusing its ID. Its children are deleted, and purged, first. A Session whose notebook a fork copied keeps the facts the copy reads until that fork is purged too.",
  )
  .scenarios(
    {
      description: "A deleted Session is purged.",
      given: [deleted("ses_1")],
      expect: [purge("ses_1")],
    },
    {
      description: "Each Session a commit deletes is purged.",
      given: [deleted("ses_1"), deleted("ses_2")],
      expect: [purge("ses_1"), purge("ses_2")],
    },
  )

export default purgeSessionSpec
