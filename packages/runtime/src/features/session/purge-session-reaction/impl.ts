import { SessionID } from "@ocpp/schema/session-id"
import { implementReaction, type ReactionPlugin, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionDeleted } from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// It folds nothing: each deletion is its own request, and a purge is
// idempotent, so a request delivered again purges nothing more.
export type PurgeSessionState = Record<string, never>

export const purgeSessionStore = Context.Service<SliceStoreService<PurgeSessionState, PurgeSessionState, unknown>>(
  "@ocpp/runtime/PurgeSessionStore",
)

export const createPurgeSessionState = (): PurgeSessionState => ({})

const purgeSessionRequest = Schema.Struct({
  type: Schema.Literal("purgeSession"),
  payload: Schema.Struct({ sessionID: SessionID }),
})
export type PurgeSessionRequest = typeof purgeSessionRequest.Type

// The Plugin is injected, as the step Reaction's is: src/plugins owns it (it
// purges through the Event Log) and src/app.ts composes it with this Reaction.
export const createPurgeSession = <R>(plugin: ReactionPlugin<PurgeSessionRequest, R>) =>
  implementReaction(specification)
    .outputSchema(Schema.toStandardSchemaV1(purgeSessionRequest))
    .plugin(plugin)
    .store(purgeSessionStore)
    .apply(sessionDeleted, async () => {})
    // Keyed by Session: each Session a commit deletes.
    .handleEachKey("session", async (_state, sessionID) => ({
      type: "purgeSession" as const,
      payload: { sessionID },
    }))
