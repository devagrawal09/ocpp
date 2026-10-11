import { Model } from "@ocpp/schema/model"
import { SessionID } from "@ocpp/schema/session-id"
import { implementCommand, type SliceStoreService } from "@specter-ts/core"
import { Context, Schema } from "effect"

import { sessionEvent } from "../../../events.ts"
import specification from "./spec.json" with { type: "json" }

// Rebuildable projection: every Session the log has named, live or deleted,
// with the model it runs on. Duplicated from the other Session Slices on
// purpose.
export type SelectModelState = {
  sessions: Record<string, { status: "live" | "deleted"; model?: Model.Ref }>
}

export const selectModelStore = Context.Service<SliceStoreService<SelectModelState, SelectModelState, unknown>>(
  "@ocpp/runtime/SelectModelStore",
)

export const createSelectModelState = (): SelectModelState => ({ sessions: {} })

const sessionCreated = sessionEvent("session-created")
const sessionDeleted = sessionEvent("session-deleted")
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
    const model = event.payload.model
    state.sessions[event.payload.sessionID] = { status: "live", ...(model === undefined ? {} : { model }) }
  })
  .apply(sessionDeleted, async (event, state) => {
    state.sessions[event.payload.sessionID] = { status: "deleted" }
  })
  .apply(modelSelected, async (event, state) => {
    const session = state.sessions[event.payload.sessionID]
    if (session) session.model = event.payload.model
  })
  .handle(async (command, state) => {
    const session = state.sessions[command.sessionID]
    if (!session) throw new Error("Session not found")
    if (session.status === "deleted") throw new Error("Session deleted")
    if (session.model && same(session.model, command.model)) throw new Error("Model already selected")
    return [
      modelSelected.create({
        sessionID: command.sessionID,
        model: command.model,
        ...(session.model === undefined ? {} : { previous: session.model }),
      }),
    ]
  })
