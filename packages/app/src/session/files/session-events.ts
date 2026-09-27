import type { CodeModeEventInfo, CodeModeEventSchedule } from "@ocpp/client/promise"

export type EventLabelKey =
  | "session.events.schedule.every"
  | "session.events.schedule.cron"
  | "session.events.schedule.at"
  | "session.events.next"
  | "session.events.next.now"
  | "session.events.next.paused"
  | "session.events.next.none"
  | "session.events.last.never"
  | "session.events.last.fired"
  | "session.events.last.running"
  | "session.events.last.completed"
  | "session.events.last.error"
  | "session.events.last.cancelled"

type Format = {
  t: (key: EventLabelKey, params?: Record<string, string | number>) => string
  locale: string
  now: number
}

/** What the Events view shows: the list, its empty state, or why there is no list yet. */
export function eventsView(events: readonly CodeModeEventInfo[] | undefined, failed: boolean) {
  if (events === undefined) return failed ? "failed" : "loading"
  return events.length === 0 ? "empty" : "list"
}

/** The schedule in words: an interval, a cron expression in the host's time zone, or one local time. */
export function scheduleLabel(schedule: CodeModeEventSchedule, format: Omit<Format, "now">) {
  if ("every" in schedule) return format.t("session.events.schedule.every", { interval: schedule.every })
  if ("cron" in schedule) return format.t("session.events.schedule.cron", { expression: schedule.cron })
  const at = Date.parse(schedule.at)
  return format.t("session.events.schedule.at", {
    time: Number.isNaN(at)
      ? schedule.at
      : new Intl.DateTimeFormat(format.locale, { dateStyle: "medium", timeStyle: "short" }).format(at),
  })
}

/** When the event fires next, or why it will not. */
export function nextLabel(event: CodeModeEventInfo, format: Format) {
  if (!event.enabled) return format.t("session.events.next.paused")
  if (!event.nextFireAt) return format.t("session.events.next.none")
  const at = Date.parse(event.nextFireAt)
  // The scheduler records the next time only after a firing starts, so a due time reads as now.
  if (at <= format.now) return format.t("session.events.next.now")
  return format.t("session.events.next", { time: relativeTime(at, format) })
}

/** The latest firing's outcome and how long ago it fired. */
export function lastLabel(event: CodeModeEventInfo, format: Format) {
  if (!event.lastFiredAt) return format.t("session.events.last.never")
  const time = relativeTime(Math.min(Date.parse(event.lastFiredAt), format.now), format)
  if (!event.lastStatus) return format.t("session.events.last.fired", { time })
  return format.t(`session.events.last.${event.lastStatus}`, { time })
}

/** A compact time relative to now, such as "in 4m" or "2h ago", in the viewer's locale. */
export function relativeTime(at: number, format: Pick<Format, "locale" | "now">) {
  const relative = new Intl.RelativeTimeFormat(format.locale, { numeric: "auto", style: "narrow" })
  const seconds = Math.round((at - format.now) / 1000)
  const size = Math.abs(seconds)
  if (size < 60) return relative.format(seconds, "second")
  if (size < 3_600) return relative.format(Math.round(seconds / 60), "minute")
  if (size < 86_400) return relative.format(Math.round(seconds / 3_600), "hour")
  return relative.format(Math.round(seconds / 86_400), "day")
}

/** A full local date and time, for a tooltip beside a relative time. */
export function absoluteTime(at: string, locale: string) {
  const time = Date.parse(at)
  if (Number.isNaN(time)) return at
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(time)
}
