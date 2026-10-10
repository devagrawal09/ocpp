import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { Ocpp, type CodeModeEventInfo, type OcppEvent } from "../src/promise"

const harness = (fetch: (request: Request) => Promise<Response>) => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const api = Ocpp.make({
    baseUrl: "http://ocpp.local",
    fetch: (input, init) => fetch(input instanceof Request ? input : new Request(input, init)),
  })
  const event: CreateDataInput["event"] = {
    on: () => () => {},
    listen(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  }
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event }),
    dispose,
  }))
  const publish = (details: OcppEvent) => listeners.forEach((listener) => listener({ name: details.type, details }))
  return { ...setup, publish }
}

const poll = (patch: Partial<CodeModeEventInfo>): CodeModeEventInfo => ({
  name: "poll",
  description: "",
  schedule: { every: "5m" },
  handler: "poll",
  enabled: true,
  runCount: 0,
  skipCount: 0,
  ...patch,
})

/** Serves the session's events from `current`, counting the reads. */
const served = (sessionID: string) => {
  const state = { current: [poll({})], reads: 0 }
  const fetch = async (request: Request) => {
    if (!request.url.endsWith(`/api/session/${sessionID}/event`)) throw new Error(`Unexpected request: ${request.url}`)
    state.reads++
    return Response.json({ data: state.current })
  }
  return { state, fetch }
}

test("refreshes a session's events when the server announces a change", async () => {
  const server = served("ses_events")
  const setup = harness(server.fetch)
  try {
    await setup.data.session.event.sync("ses_events")
    expect(setup.data.session.event.list("ses_events")).toEqual([poll({})])
    server.state.current = [poll({ enabled: false })]
    setup.publish({
      id: "evt_updated",
      created: 1,
      type: "codemode-event-updated",
      data: { sessionID: "ses_events", name: "poll" },
    })
    await wait(() => setup.data.session.event.list("ses_events")?.[0]?.enabled === false)
    // Another session's change leaves this list alone.
    setup.publish({
      id: "evt_other",
      created: 2,
      type: "codemode-event-updated",
      data: { sessionID: "ses_other", name: "poll" },
    })
    await Bun.sleep(20)
    expect(server.state.reads).toBe(2)
  } finally {
    setup.dispose()
  }
})

test("refreshes an event's latest outcome when its firing settles", async () => {
  const server = served("ses_firing")
  server.state.current = [poll({ lastMessageID: "msg_firing", lastStatus: "running", runCount: 1 })]
  const setup = harness(server.fetch)
  try {
    await setup.data.session.event.sync("ses_firing")
    const base = { sessionID: "ses_firing", id: "call_other", executionID: "exe_other", events: [] }
    // A program the model ran settling is not an event's firing.
    setup.publish({
      id: "evt_other",
      created: 1,
      type: "session-codemode-completed",
      durable: { aggregateID: "ses_firing", seq: 1, version: 1 },
      data: { ...base, assistantMessageID: "msg_other" },
    })
    await Bun.sleep(20)
    expect(server.state.reads).toBe(1)
    server.state.current = [poll({ lastMessageID: "msg_firing", lastStatus: "error", runCount: 1 })]
    setup.publish({
      id: "evt_failed",
      created: 2,
      type: "session-codemode-failed",
      durable: { aggregateID: "ses_firing", seq: 2, version: 1 },
      data: {
        ...base,
        assistantMessageID: "msg_firing",
        id: "msg_firing",
        executionID: "exe_firing",
        status: "error",
        error: "boom",
      },
    })
    await wait(() => setup.data.session.event.list("ses_firing")?.[0]?.lastStatus === "error")
  } finally {
    setup.dispose()
  }
})

test("refreshes the events when a firing settles before the list names it", async () => {
  const server = served("ses_quick")
  const setup = harness(async (request) => {
    // The timeline's first page is empty; the firing arrives live.
    if (new URL(request.url).pathname === "/api/session/ses_quick/message")
      return Response.json({ data: [], cursor: {} })
    return server.fetch(request)
  })
  try {
    await setup.data.session.message.sync("ses_quick")
    await setup.data.session.event.sync("ses_quick")
    setup.publish({
      id: "evt_quick",
      created: 1,
      type: "session-invocation-started",
      durable: { aggregateID: "ses_quick", seq: 1, version: 1 },
      data: {
        sessionID: "ses_quick",
        executionID: "exe_quick",
        trigger: { type: "event", name: "poll" },
        handler: "poll",
        input: { event: "poll" },
      },
    })
    server.state.current = [poll({ lastMessageID: "msg_quick", lastStatus: "completed", runCount: 1 })]
    setup.publish({
      id: "evt_done",
      created: 2,
      type: "session-codemode-completed",
      durable: { aggregateID: "ses_quick", seq: 2, version: 1 },
      data: {
        sessionID: "ses_quick",
        assistantMessageID: "msg_quick",
        id: "msg_quick",
        executionID: "exe_quick",
        events: [],
      },
    })
    await wait(() => setup.data.session.event.list("ses_quick")?.[0]?.lastStatus === "completed")
  } finally {
    setup.dispose()
  }
})

test("refreshes a session's events after a revert", async () => {
  const server = served("ses_revert")
  const setup = harness(server.fetch)
  try {
    await setup.data.session.event.sync("ses_revert")
    server.state.current = [poll({ name: "watch", handler: "watch" })]
    // A revert removes events whose handler it removed from the notebook.
    setup.publish({
      id: "evt_revert",
      created: 1,
      type: "session-revert-committed",
      durable: { aggregateID: "ses_revert", seq: 1, version: 1 },
      data: { sessionID: "ses_revert", to: "msg_revert" },
    })
    await wait(() => setup.data.session.event.list("ses_revert")?.[0]?.name === "watch")
  } finally {
    setup.dispose()
  }
})

async function wait(check: () => boolean) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > 2_000) throw new Error("Timed out waiting for condition")
    await Bun.sleep(10)
  }
}
