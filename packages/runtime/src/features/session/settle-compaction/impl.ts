import { Money } from "@ocpp/schema/money"
import { SessionEvent } from "@ocpp/schema/session-event"
import { TokenUsage } from "@ocpp/schema/token-usage"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session ID the log has named, live or
// deleted, and the Sessions with a compaction running. Duplicated from the
// other Session Slices on purpose.
export type SettleCompactionState = {
  sessions: Record<string, "live" | "deleted">
  running: Record<string, true>
}

export const settleCompactionStore = Context.Service<
  SliceStoreService<SettleCompactionState, SettleCompactionState, unknown>
>("@ocpp/runtime/SettleCompactionStore")

export const createSettleCompactionState = (): SettleCompactionState => ({ sessions: {}, running: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
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
  .apply(sessionCreated, async (event, state) => {
    state.sessions[event.payload.sessionID] = "live"
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = "deleted"
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
    if (!state.sessions[settled.sessionID]) throw new Error("Session not found")
    if (state.sessions[settled.sessionID] === "deleted") throw new Error("Session deleted")
    if (settled.outcome === "completed" && !state.running[settled.sessionID]) throw new Error("No compaction running")
    return [
      ...(usage === undefined
        ? []
        : [usageRecorded.create({ sessionID: settled.sessionID, source: "compaction", ...usage })]),
      compactionSettled.create(settled),
    ]
  })
