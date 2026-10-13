import { describe, expect, test } from "bun:test"
import { STOP_CONFIRM_MS, STOP_REPEAT_MS, expireStop, pressStop, stopIdle, type StopState } from "./stop"

/** Presses in order, each at its own time, returning the actions. */
function presses(steps: { at: number; working: boolean; background: number }[]) {
  let state: StopState = stopIdle
  return steps.map((step) => {
    const result = pressStop(state, { now: step.at, working: step.working, background: step.background })
    state = result.state
    return result.action
  })
}

describe("composer stop gesture", () => {
  test("a single press stops the turn", () => {
    expect(presses([{ at: 0, working: true, background: 2 }])).toEqual(["turn"])
  })

  test("press, quick repeat, then confirm stops all background work", () => {
    expect(
      presses([
        { at: 0, working: true, background: 2 },
        { at: 500, working: false, background: 2 },
        { at: 2_000, working: false, background: 2 },
      ]),
    ).toEqual(["turn", "confirm", "all"])
  })

  test("the repeat still escalates while the stopping turn reports working", () => {
    expect(
      presses([
        { at: 0, working: true, background: 1 },
        { at: 100, working: true, background: 1 },
      ]),
    ).toEqual(["turn", "confirm"])
  })

  test("a slow repeat stops the turn again instead of escalating", () => {
    expect(
      presses([
        { at: 0, working: true, background: 1 },
        { at: STOP_REPEAT_MS + 1, working: true, background: 1 },
      ]),
    ).toEqual(["turn", "turn"])
  })

  test("a lapsed confirmation starts over", () => {
    expect(
      presses([
        { at: 0, working: true, background: 1 },
        { at: 500, working: false, background: 1 },
        { at: 500 + STOP_CONFIRM_MS + 1, working: false, background: 1 },
      ]),
    ).toEqual(["turn", "confirm", "confirm"])
  })

  test("without background work the repeat does nothing extra", () => {
    expect(
      presses([
        { at: 0, working: true, background: 0 },
        { at: 500, working: false, background: 0 },
        { at: 900, working: false, background: 0 },
      ]),
    ).toEqual(["turn", "none", "none"])
  })

  test("an idle session with background work goes straight to the confirmation", () => {
    expect(
      presses([
        { at: 0, working: false, background: 3 },
        { at: 1_000, working: false, background: 3 },
      ]),
    ).toEqual(["confirm", "all"])
  })

  test("a confirmation whose background work finished does not stop anything", () => {
    expect(
      presses([
        { at: 0, working: false, background: 1 },
        { at: 1_000, working: false, background: 0 },
      ]),
    ).toEqual(["confirm", "none"])
  })

  test("an idle session without background work ignores the press", () => {
    expect(presses([{ at: 0, working: false, background: 0 }])).toEqual(["none"])
  })

  test("windows expire", () => {
    expect(expireStop({ type: "stopped", at: 0 }, STOP_REPEAT_MS)).toEqual({ type: "stopped", at: 0 })
    expect(expireStop({ type: "stopped", at: 0 }, STOP_REPEAT_MS + 1)).toEqual(stopIdle)
    expect(expireStop({ type: "confirm", at: 0 }, STOP_CONFIRM_MS)).toEqual({ type: "confirm", at: 0 })
    expect(expireStop({ type: "confirm", at: 0 }, STOP_CONFIRM_MS + 1)).toEqual(stopIdle)
  })
})
