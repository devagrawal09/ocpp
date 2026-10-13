import { createSignal, onCleanup, type Accessor } from "solid-js"

/** Work a Session runs outside its turn: Code Mode executions and the subagents they run. */
export type StopBackground = { executions: number; subagents: number }

/**
 * Where the stop gesture is. "stopped": the turn was just stopped, so a quick repeat escalates.
 * "confirm": stopping all background work waits for one more press.
 */
export type StopState = { type: "idle" } | { type: "stopped"; at: number } | { type: "confirm"; at: number }

/** What a press does: interrupt the turn, ask to confirm stopping everything, stop everything, or nothing. */
export type StopAction = "turn" | "confirm" | "all" | "none"

/** How soon after stopping the turn a repeat press asks to stop background work too. */
export const STOP_REPEAT_MS = 1_500
/** How long the confirmation waits for the press that stops all background work. */
export const STOP_CONFIRM_MS = 3_000

export const stopIdle: StopState = { type: "idle" }

export function backgroundCount(background: StopBackground) {
  return background.executions + background.subagents
}

/**
 * One press of Esc or the stop button. The first press stops the turn as it always has; pressing again
 * quickly while background work runs asks to confirm, and a third press within the confirmation window
 * stops everything. A Session that is idle but still runs background work goes straight to the
 * confirmation, since stopping its turn would do nothing.
 */
export function pressStop(
  state: StopState,
  input: { now: number; working: boolean; background: number },
): { state: StopState; action: StopAction } {
  const current = expireStop(state, input.now)
  if (current.type === "confirm") {
    if (input.background > 0) return { state: stopIdle, action: "all" }
    return { state: stopIdle, action: input.working ? "turn" : "none" }
  }
  if (current.type === "stopped" && input.background > 0) return { state: { type: "confirm", at: input.now }, action: "confirm" }
  if (input.working) return { state: { type: "stopped", at: input.now }, action: "turn" }
  if (current.type === "stopped") return { state: current, action: "none" }
  if (input.background > 0) return { state: { type: "confirm", at: input.now }, action: "confirm" }
  return { state: stopIdle, action: "none" }
}

/** Drops a repeat or confirmation window that has lapsed. */
export function expireStop(state: StopState, now: number): StopState {
  if (state.type === "stopped" && now - state.at > STOP_REPEAT_MS) return stopIdle
  if (state.type === "confirm" && now - state.at > STOP_CONFIRM_MS) return stopIdle
  return state
}

/** The stop gesture of a composer, with its confirmation lapsing on its own. */
export function createStopGesture(input: {
  working: Accessor<boolean>
  background: Accessor<StopBackground>
  interrupt: (scope: "turn" | "all") => void
  now?: () => number
}) {
  const now = input.now ?? Date.now
  const [state, setState] = createSignal<StopState>(stopIdle)
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (next: StopState) => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    setState(next)
    if (next.type === "idle") return
    timer = setTimeout(() => setState((current) => expireStop(current, now())), (next.type === "confirm" ? STOP_CONFIRM_MS : STOP_REPEAT_MS) + 1)
  }
  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer)
  })

  return {
    /** Whether a press does anything: a turn runs, background work runs, or a confirmation waits. */
    available: () => input.working() || backgroundCount(input.background()) > 0 || state().type === "confirm",
    /** The background work a pending confirmation would stop, while it waits and that work still runs. */
    confirming: (): StopBackground | undefined => {
      if (state().type !== "confirm") return undefined
      const background = input.background()
      return backgroundCount(background) > 0 ? background : undefined
    },
    press: () => {
      const result = pressStop(state(), {
        now: now(),
        working: input.working(),
        background: backgroundCount(input.background()),
      })
      schedule(result.state)
      if (result.action === "turn" || result.action === "all") input.interrupt(result.action)
      return result.action
    },
  }
}
