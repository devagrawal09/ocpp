import { CommandRejection, type EventForDefinition } from "@specter-ts/core"

import { sessionEvent } from "../../events.ts"

// The Session lifecycle many Slices fold: whether a Session exists or was
// deleted, whether an execution is active, and which step is in flight. Shared
// code, not shared State: each Slice registers these handlers with its own
// `.apply` and keeps the result in its own State, beside what it folds itself.

export const sessionCreated = sessionEvent("session-created")
export const sessionDeleted = sessionEvent("session-deleted")
export const executionStarted = sessionEvent("session-execution-started")
export const executionSettled = sessionEvent("session-execution-settled")
export const stepSettled = sessionEvent("session-step-settled")

// Every Session ID the log has named, live or deleted.
export type SessionsState = { sessions: Record<string, "live" | "deleted"> }

// The Sessions with an active execution.
export type ActiveState = { active: Record<string, true> }

// The step each Session has in flight: its assistant message, alone or with
// what the Slice keeps about the step.
export type StepsInFlightState = {
  inFlight: Record<string, string | { readonly assistantMessageID: string }>
}

export const applySessionCreated = async (event: EventForDefinition<typeof sessionCreated>, state: SessionsState) => {
  state.sessions[event.payload.sessionID] = "live"
}

export const applySessionDeleted = async (event: EventForDefinition<typeof sessionDeleted>, state: SessionsState) => {
  state.sessions[event.payload.sessionID] = "deleted"
}

export const applyExecutionStarted = async (event: EventForDefinition<typeof executionStarted>, state: ActiveState) => {
  state.active[event.payload.sessionID] = true
}

export const applyExecutionSettled = async (event: EventForDefinition<typeof executionSettled>, state: ActiveState) => {
  delete state.active[event.payload.sessionID]
}

// An execution's settlement ends its activity and the step it had in flight.
export const settleExecution = (state: ActiveState & StepsInFlightState, sessionID: string) => {
  delete state.active[sessionID]
  delete state.inFlight[sessionID]
}

// A step closes only by its own settlement: a stale one leaves the Session's
// next step in flight.
export const closeStep = (state: StepsInFlightState, sessionID: string, assistantMessageID: string) => {
  const step = state.inFlight[sessionID]
  if ((typeof step === "string" ? step : step?.assistantMessageID) === assistantMessageID)
    delete state.inFlight[sessionID]
}

export const applyStepSettled = async (event: EventForDefinition<typeof stepSettled>, state: StepsInFlightState) => {
  closeStep(state, event.payload.sessionID, event.payload.assistantMessageID)
}

// Every Session Command's first rule: it refuses a Session the log never
// created, and one it deleted.
export const requireLiveSession = (state: Readonly<SessionsState>, sessionID: string) => {
  const status = state.sessions[sessionID]
  if (!status) throw new CommandRejection("session-not-found", "Session not found")
  if (status === "deleted") throw new CommandRejection("session-deleted", "Session deleted")
}
