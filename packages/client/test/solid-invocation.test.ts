import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { Ocpp, type OcppEvent } from "../src/promise"

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

test("projects an invocation and its Code Mode run", async () => {
  const setup = harness(async () => Response.json({ data: [], cursor: {} }))
  try {
    await setup.data.session.message.sync("ses_invocation")
    const base = { sessionID: "ses_invocation", assistantMessageID: "msg_invocation", id: "msg_invocation" }
    setup.publish({
      id: "evt_invocation",
      created: 1,
      type: "session.invocation.started",
      durable: { aggregateID: "ses_invocation", seq: 1, version: 1 },
      data: {
        sessionID: "ses_invocation",
        executionID: "exe_invocation",
        trigger: { type: "command", name: "triage", text: "login fails" },
        code: 'return triage({"text":"login fails","command":"triage"})',
      },
    })
    setup.publish({
      id: "evt_progress",
      created: 2,
      type: "session.codemode.progress",
      data: {
        ...base,
        executionID: "exe_invocation",
        events: [{ type: "trace", kind: "log", method: "log", message: "a" }],
      },
    })
    expect(setup.data.session.message.get("ses_invocation", "msg_invocation")).toMatchObject({
      type: "invocation",
      status: "running",
      events: [{ type: "trace", kind: "log", method: "log", message: "a" }],
    })
    setup.publish({
      id: "evt_completed",
      created: 3,
      type: "session.codemode.completed",
      durable: { aggregateID: "ses_invocation", seq: 2, version: 1 },
      data: { ...base, executionID: "exe_invocation", events: [{ type: "trace", kind: "return", value: "done" }] },
    })
    expect(setup.data.session.message.get("ses_invocation", "msg_invocation")).toMatchObject({
      type: "invocation",
      trigger: { type: "command", name: "triage", text: "login fails" },
      status: "completed",
      events: [{ type: "trace", kind: "return", value: "done" }],
      time: { created: 1, completed: 3 },
    })
  } finally {
    setup.dispose()
  }
})

test("refreshes a session's commands when commands change", async () => {
  let commands = [{ name: "triage", description: "", handler: "triage" }]
  const setup = harness(async (request) => {
    // The Location's own command list refreshes on the same event.
    if (new URL(request.url).pathname === "/api/command")
      return Response.json({ location: { directory: "/project" }, data: [] })
    if (!request.url.endsWith("/api/session/ses_commands/command"))
      throw new Error(`Unexpected request: ${request.url}`)
    return Response.json({ data: commands })
  })
  try {
    await setup.data.session.command.sync("ses_commands")
    expect(setup.data.session.command.list("ses_commands")).toEqual(commands)
    commands = [...commands, { name: "watch", description: "Watch", handler: "watch" }]
    setup.publish({
      id: "evt_command_updated",
      created: 1,
      type: "command.updated",
      location: { directory: "/project" },
      data: {},
    })
    await wait(() => setup.data.session.command.list("ses_commands")?.length === 2)
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
