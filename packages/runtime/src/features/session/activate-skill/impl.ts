import { SessionEvent } from "@ocpp/schema/session-event"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
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

// Rebuildable projection: every Session ID the log has named, live or deleted.
// Its Session lifecycle is the shared fold in session/lifecycle.ts.
export type ActivateSkillState = {
  sessions: Record<string, "live" | "deleted">
}

export const activateSkillStore = Context.Service<SliceStoreService<ActivateSkillState, ActivateSkillState, unknown>>(
  "@ocpp/runtime/ActivateSkillStore",
)

export const createActivateSkillState = (): ActivateSkillState => ({ sessions: {} })

const skillActivated = sessionEvent("session-skill-activated")

const input = Schema.toStandardSchemaV1(SessionEvent.Skill.Activated.data)

export const activateSkill = implementCommand(specification)
  .inputSchema(input)
  .store(activateSkillStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, applySessionCreated)
  .apply(sessionDeleted, applySessionDeleted)
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    return [skillActivated.create(command)]
  })
