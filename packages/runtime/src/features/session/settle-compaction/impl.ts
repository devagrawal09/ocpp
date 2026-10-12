import { Money } from "@ocpp/schema/money"
import { SessionEvent } from "@ocpp/schema/session-event"
import { TokenUsage } from "@ocpp/schema/token-usage"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applySessionCreated,
  applySessionDeleted,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or deleted,
// and the Sessions with a compaction running. Its Session lifecycle is the
// shared fold in session/lifecycle.ts; the rest is duplicated from the other
// Session Slices on purpose.
export type SettleCompactionState = {
  sessions: Record<string, "live" | "deleted">
  running: Record<string, true>
}

export const settleCompactionStore = Context.Service<
  SliceStoreService<SettleCompactionState, SettleCompactionState, unknown>
>("@ocpp/runtime/SettleCompactionStore")

export const createSettleCompactionState = (): SettleCompactionState => ({ sessions: {}, running: {} })

const compactionStarted = sessionEvent("session-compaction-started")
const compactionSettled = sessionEvent("session-compaction-settled")
const usageRecorded = sessionEvent("session-usage-recorded")

// What the compaction spent, recorded with its outcome.
const usage = Schema.optional(Schema.Struct({ cost: Money.USD, tokens: TokenUsage.Info }))
const [completed, failed] = SessionEvent.Compaction.Settled.data.members
const input = Schema.toStandardSchemaV1(
  Schema.Union([Schema.Struct({ ...completed.fields, usage }), Schema.Struct({ ...failed.fields, usage })]),
)

export const settleCompaction = implementCommand(specification)
  .inputSchema(input)
  .store(settleCompactionStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
    delete state.running[event.payload.sessionID]
  })
  .apply(compactionStarted, async (event, state) => {
    state.running[event.payload.sessionID] = true
  })
  .apply(compactionSettled, async (event, state) => {
    delete state.running[event.payload.sessionID]
  })
  .handle(async (command, state) => {
    const { usage, ...settled } = command
    requireLiveSession(state, settled.sessionID)
    if (settled.outcome === "completed" && !state.running[settled.sessionID])
      throw new CommandRejection("no-compaction-running", "No compaction running")
    return [
      ...(usage === undefined
        ? []
        : [usageRecorded.create({ sessionID: settled.sessionID, source: "compaction", ...usage })]),
      compactionSettled.create(settled),
    ]
  })
