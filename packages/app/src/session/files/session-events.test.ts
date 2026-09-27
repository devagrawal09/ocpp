import { describe, expect, test } from "bun:test"
import type { CodeModeEventInfo } from "@ocpp/client/promise"
import en from "@/runtime/i18n/en"
import { eventsView, lastLabel, nextLabel, relativeTime, scheduleLabel } from "./session-events"

const now = Date.parse("2026-09-27T17:00:00.000Z")
const t = (key: keyof typeof en, params?: Record<string, string | number>) =>
  en[key].replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(params?.[name]))
const format = { t, locale: "en", now }
const at = (ms: number) => new Date(now + ms).toISOString()

const event = (patch: Partial<CodeModeEventInfo>): CodeModeEventInfo => ({
  name: "poll",
  description: "",
  schedule: { every: "5m" },
  handler: "poll",
  enabled: true,
  runCount: 0,
  skipCount: 0,
  ...patch,
})

describe("eventsView", () => {
  test("shows the empty state once a session has no events", () => {
    expect(eventsView([], false)).toBe("empty")
    expect(eventsView([event({})], false)).toBe("list")
  })

  test("waits for the first read, and says when it failed", () => {
    expect(eventsView(undefined, false)).toBe("loading")
    expect(eventsView(undefined, true)).toBe("failed")
    // A list read before a later failure stays on screen.
    expect(eventsView([event({})], true)).toBe("list")
  })
})

describe("scheduleLabel", () => {
  test("words each kind of schedule", () => {
    expect(scheduleLabel({ every: "5m" }, format)).toBe("Every 5m")
    expect(scheduleLabel({ cron: "0 9 * * 1-5" }, format)).toBe("Cron 0 9 * * 1-5")
    expect(scheduleLabel({ at: at(3_600_000) }, format)).toMatch(/^Once at .*2026/)
  })

  test("keeps a time it cannot read as written", () => {
    expect(scheduleLabel({ at: "tomorrow" }, format)).toBe("Once at tomorrow")
  })
})

describe("nextLabel", () => {
  test("counts down to the next firing", () => {
    expect(nextLabel(event({ nextFireAt: at(4 * 60_000) }), format)).toBe("Next in 4m")
    expect(nextLabel(event({ nextFireAt: at(12_000) }), format)).toBe("Next in 12s")
    expect(nextLabel(event({ nextFireAt: at(3 * 3_600_000) }), format)).toBe("Next in 3h")
  })

  test("reads a due firing as now rather than in the past", () => {
    expect(nextLabel(event({ nextFireAt: at(-2_000) }), format)).toBe("Firing now")
  })

  test("says why an event will not fire", () => {
    expect(nextLabel(event({ enabled: false }), format)).toBe("Paused")
    // A one-time event that already fired has nothing scheduled.
    expect(nextLabel(event({ schedule: { at: at(-60_000) } }), format)).toBe("No upcoming firing")
  })
})

describe("lastLabel", () => {
  test("describes the latest firing's outcome and age", () => {
    expect(lastLabel(event({}), format)).toBe("Never fired")
    expect(lastLabel(event({ lastFiredAt: at(-2 * 60_000), lastStatus: "completed" }), format)).toBe("Succeeded 2m ago")
    expect(lastLabel(event({ lastFiredAt: at(-30_000), lastStatus: "error" }), format)).toBe("Failed 30s ago")
    expect(lastLabel(event({ lastFiredAt: at(-5_000), lastStatus: "running" }), format)).toBe(
      "Started 5s ago, still running",
    )
    expect(lastLabel(event({ lastFiredAt: at(-3_600_000), lastStatus: "cancelled" }), format)).toBe("Cancelled 1h ago")
    // The outcome is unknown when its invocation message is gone.
    expect(lastLabel(event({ lastFiredAt: at(-60_000) }), format)).toBe("Fired 1m ago")
  })

  test("never places a firing in the future when clocks disagree", () => {
    expect(lastLabel(event({ lastFiredAt: at(1_500), lastStatus: "completed" }), format)).toBe("Succeeded now")
  })
})

describe("relativeTime", () => {
  test("uses the largest unit that fits", () => {
    expect(relativeTime(now, format)).toBe("now")
    expect(relativeTime(now - 59_000, format)).toBe("59s ago")
    expect(relativeTime(now + 90_000, format)).toBe("in 2m")
    expect(relativeTime(now - 86_400_000, format)).toBe("yesterday")
  })
})
