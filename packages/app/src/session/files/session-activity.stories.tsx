import type { CodeModeEventInfo } from "@ocpp/client/promise"
import type { JSX } from "solid-js"
import { SessionEventsView } from "./session-events-tab"
import { SessionRunningView } from "./session-running-tab"
import type { RunningItem } from "./session-running"

const now = Date.parse("2026-09-27T17:00:00.000Z")
const ago = (ms: number) => new Date(now - ms).toISOString()
const location = { directory: "/repo" }

const running: RunningItem[] = [
  {
    id: "call_triage",
    kind: "execution",
    label: "const issues = await tools.linear.search_issues({ state: 'triage' })",
    started: now - 94_000,
    steps: 14,
    tool: "subagent",
    target: { messageID: "msg_triage", partID: "call_triage" },
    stop: { type: "execution", sessionID: "ses_demo", executionID: "exe_triage" },
  },
  {
    id: "ses_review",
    kind: "subagent",
    label: "Review the parser changes",
    agent: "explore",
    title: "Parser review",
    started: now - 61_000,
    working: true,
    parent: "call_triage",
    target: { messageID: "msg_triage", partID: "call_triage" },
    child: "ses_review",
    stop: { type: "subagent", sessionID: "ses_review" },
  },
  {
    id: "sh_tests",
    kind: "shell",
    label: "bun test packages/core",
    started: now - 12_000,
    parent: "call_triage",
    target: { messageID: "msg_triage", partID: "call_triage" },
    stop: { type: "shell", shellID: "sh_tests", location },
  },
  {
    id: "exe_poll",
    kind: "execution",
    label: 'return pollGithub({"event":"poll-github","firedAt":"2026-09-27T16:59:58.000Z"})',
    trigger: { type: "event", name: "poll-github" },
    started: now - 2_000,
    steps: 2,
    tool: "github.search_issues",
    target: { messageID: "msg_poll" },
    stop: { type: "execution", sessionID: "ses_demo", executionID: "exe_poll" },
  },
  {
    id: "sh_server",
    kind: "shell",
    label: "npm run dev -- --port 4444",
    started: now - 3_720_000,
    target: { messageID: "msg_server" },
    stop: { type: "shell", shellID: "sh_server", location },
  },
  {
    id: "call_done",
    kind: "execution",
    label: "return summarize(findings)",
    started: now - 8_000,
    steps: 6,
    target: { messageID: "msg_done", partID: "call_done" },
    finished: now - 1_000,
  },
]

const events: CodeModeEventInfo[] = [
  {
    name: "poll-github",
    description: "Triage new GitHub issues and start a fix for the urgent ones",
    schedule: { every: "5m" },
    handler: "pollGithub",
    enabled: true,
    nextFireAt: new Date(now + 238_000).toISOString(),
    lastFiredAt: ago(62_000),
    lastStatus: "completed",
    lastMessageID: "msg_poll",
    lastSummary: '{"triaged":4,"urgent":1,"started":"ses_fix_login"}',
    runCount: 12,
    skipCount: 1,
    lastSkippedAt: ago(1_800_000),
  },
  {
    name: "nightly-report",
    description: "",
    schedule: { cron: "0 9 * * 1-5" },
    handler: "report",
    enabled: false,
    lastFiredAt: ago(86_400_000),
    lastStatus: "error",
    lastMessageID: "msg_report",
    lastSummary: "Sentry request failed: 401 Unauthorized",
    runCount: 3,
    skipCount: 0,
  },
  {
    name: "launch-check",
    description: "Check the launch checklist once before the demo",
    schedule: { at: new Date(now + 3_600_000).toISOString() },
    handler: "launchCheck",
    enabled: true,
    nextFireAt: new Date(now + 3_600_000).toISOString(),
    runCount: 0,
    skipCount: 0,
  },
]

const noop = () => {}

// The side panel can be resized down to a narrow column beside the timeline.
const Panel = (props: { narrow?: boolean; children: JSX.Element }) => (
  <div
    class="h-[520px] max-w-full overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
    classList={{ "w-[360px]": !props.narrow, "w-[240px]": props.narrow }}
  >
    {props.children}
  </div>
)

export default {
  title: "OC++/Session/Side panel activity",
  id: "session-side-panel-activity",
  parameters: {
    docs: {
      description: {
        component:
          "The side panel's Running and Events views: everything running in the session, and the events the agent defined with tools.event.define.",
      },
    },
  },
}

export const Running = {
  render: () => (
    <Panel>
      <SessionRunningView
        items={running}
        now={now}
        stopping={(id) => id === "sh_server"}
        onShow={noop}
        onOpen={noop}
        onStop={noop}
      />
    </Panel>
  ),
}

export const RunningNarrow = {
  render: () => (
    <Panel narrow>
      <SessionRunningView items={running} now={now} stopping={() => false} onShow={noop} onOpen={noop} onStop={noop} />
    </Panel>
  ),
}

export const NothingRunning = {
  render: () => (
    <Panel>
      <SessionRunningView items={[]} now={now} stopping={() => false} onShow={noop} onOpen={noop} onStop={noop} />
    </Panel>
  ),
}

export const Events = {
  render: () => (
    <Panel>
      <SessionEventsView
        events={events}
        failed={false}
        now={now}
        pending={(name) => name === "nightly-report"}
        onToggle={noop}
        onRun={noop}
        onRemove={noop}
        onShow={noop}
      />
    </Panel>
  ),
}

export const EventsNarrow = {
  render: () => (
    <Panel narrow>
      <SessionEventsView
        events={events}
        failed={false}
        now={now}
        pending={() => false}
        onToggle={noop}
        onRun={noop}
        onRemove={noop}
        onShow={noop}
      />
    </Panel>
  ),
}

export const NoEvents = {
  render: () => (
    <Panel>
      <SessionEventsView
        events={[]}
        failed={false}
        now={now}
        pending={() => false}
        onToggle={noop}
        onRun={noop}
        onRemove={noop}
        onShow={noop}
      />
    </Panel>
  ),
}
