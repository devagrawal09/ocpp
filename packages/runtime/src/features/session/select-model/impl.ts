import { Model } from "@ocpp/schema/model"
import { SessionID } from "@ocpp/schema/session-id"
import { CommandRejection, implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import {
  applySessionCreated,
  applySessionDeleted,
  requireLiveSession,
  sessionCreated,
  sessionDeleted,
  type SessionsState,
} from "../lifecycle.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session the log has named, live or deleted
// (the shared Session lifecycle), and the model each live Session runs on.
export type SelectModelState = SessionsState & { models: Record<string, Model.Ref> }

export const selectModelStore = Context.Service<SliceStoreService<SelectModelState, SelectModelState, unknown>>(
  "@ocpp/runtime/SelectModelStore",
)

export const createSelectModelState = (): SelectModelState => ({ sessions: {}, models: {} })

const modelSelected = sessionEvent("session-model-selected")

const input = Schema.toStandardSchemaV1(Schema.Struct({ sessionID: SessionID, model: Model.Ref }))

// One selection: a model without a variant runs its default one.
const same = (left: Model.Ref, right: Model.Ref) =>
  left.providerID === right.providerID &&
  left.id === right.id &&
  (left.variant ?? "default") === (right.variant ?? "default")

export const selectModel = implementCommand(specification)
  .inputSchema(input)
  .store(selectModelStore)
  .consistencyKeys({ session: (command) => command.sessionID })
  .apply(sessionCreated, async (event, state) => {
    await applySessionCreated(event, state)
    if (event.payload.model !== undefined) state.models[event.payload.sessionID] = event.payload.model
  })
  .apply(sessionDeleted, async (event, state) => {
    await applySessionDeleted(event, state)
    delete state.models[event.payload.sessionID]
  })
  .apply(modelSelected, async (event, state) => {
    if (state.sessions[event.payload.sessionID]) state.models[event.payload.sessionID] = event.payload.model
  })
  .handle(async (command, state) => {
    requireLiveSession(state, command.sessionID)
    const previous = state.models[command.sessionID]
    if (previous && same(previous, command.model))
      throw new CommandRejection("model-already-selected", "Model already selected")
    return [
      modelSelected.create({
        sessionID: command.sessionID,
        model: command.model,
        ...(previous === undefined ? {} : { previous }),
      }),
    ]
  })
