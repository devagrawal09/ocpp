import { beforeAll, expect, mock, test } from "bun:test"
import { createEffect, createRoot } from "solid-js"
import type { ReviewPanelState } from "@/session/review/panel-state"

let createReviewPanelState: () => ReviewPanelState

beforeAll(async () => {
  mock.module("@ocpp/session-ui/v2/session-review-v2", () => ({
    SESSION_REVIEW_V2_SIDEBAR_WIDTH_DEFAULT: 240,
    SESSION_REVIEW_V2_SIDEBAR_WIDTH_MIN: 200,
    SESSION_REVIEW_V2_SIDEBAR_WIDTH_MAX: 480,
  }))

  createReviewPanelState = (await import("@/session/review/panel-state")).createReviewPanelState
})

test("hydrates a custom sidebar width before enabling sidebar motion", async () => {
  localStorage.setItem(
    "ocpp.global.dat:review-panel-v2",
    JSON.stringify({ sidebarOpened: true, sidebarWidth: 360, expandMode: "collapse" }),
  )

  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      const state = createReviewPanelState()
      createEffect(() => {
        if (!state.sidebarTransition()) return
        try {
          expect(state.sidebarWidth()).toBe(360)
          dispose()
          resolve()
        } catch (error) {
          dispose()
          reject(error)
        }
      })
    })
  })
})
