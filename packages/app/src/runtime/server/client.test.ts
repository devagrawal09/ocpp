import { describe, expect, test } from "bun:test"
import type { OcppEvent } from "@ocpp/client/promise"
import { createRoot } from "solid-js"
import { createOcppEventSource, createServerTransport } from "./client"

const form = {
  id: "evt_form",
  created: 1,
  type: "form-created",
  location: { directory: "/repo", workspaceID: "workspace_1" },
  data: {
    form: { id: "form_1", sessionID: "ses_1", title: "Questions", fields: [{ key: "q0", type: "string" }] },
  },
} satisfies Extract<OcppEvent, { type: "form-created" }>

function setup() {
  return createRoot((dispose) => ({ ...createOcppEventSource(), dispose }))
}

describe("server event stream", () => {
  test("publishes the original current event with exact data", () => {
    const server = setup()
    const received: OcppEvent[] = []
    let requestID: string | undefined

    server.event.on("form-created", (event) => {
      requestID = event.data.form.id
    })
    server.event.listen((event) => received.push(event))
    server.publish(form)

    expect(requestID).toBe("form_1")
    expect(received).toEqual([form])
    expect(received[0]).toBe(form)
    server.dispose()
  })

  test("filters locations without changing workspace identity", () => {
    const server = setup()
    const repo: OcppEvent[] = []
    const other: OcppEvent[] = []
    const all: OcppEvent[] = []
    let workspaceID: string | undefined
    const global = {
      id: "evt_connected",
      type: "server-connected",
      data: {},
    } satisfies Extract<OcppEvent, { type: "server-connected" }>

    const repoEvents = server.event.location("/repo")
    repoEvents.on("form-created", (event) => {
      workspaceID = event.location?.workspaceID
    })
    repoEvents.listen((event) => repo.push(event))
    server.event.location("/other").listen((event) => other.push(event))
    server.event.listen((event) => all.push(event))
    server.publish(form)
    server.publish(global)

    expect(repo).toEqual([form])
    expect(workspaceID).toBe("workspace_1")
    expect(other).toEqual([])
    expect(all).toEqual([form, global])
    server.dispose()
  })

  test("isolates servers and clears subscriptions with their owner", () => {
    const first = setup()
    const second = setup()
    const received = { first: 0, second: 0 }

    first.event.listen(() => received.first++)
    second.event.listen(() => received.second++)
    first.publish(form)
    first.dispose()
    first.publish(form)
    second.publish(form)

    expect(received).toEqual({ first: 1, second: 1 })
    second.dispose()
  })
})

test("rotates HTTP and PTY clients together", async () => {
  const requests: Array<{ url: string; authorization: string | null }> = []
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    requests.push({ url: request.url, authorization: request.headers.get("authorization") })
    return Response.json({ healthy: true, version: "2.0.0-test", pid: 1 })
  }) as typeof globalThis.fetch
  const transport = createServerTransport({
    http: { url: "http://127.0.0.1:4100", username: "ocpp", password: "first" },
    fetch,
  })
  const initialPty = transport.pty

  await transport.api.health.get()
  const replacement = transport.update({
    url: "http://127.0.0.1:4200",
    username: "ocpp",
    password: "second",
  })
  await transport.api.health.get()

  expect(replacement).toBe(transport.api)
  expect(transport.pty).not.toBe(initialPty)
  expect(transport.url).toBe("http://127.0.0.1:4200")
  expect(requests).toEqual([
    {
      url: "http://127.0.0.1:4100/api/health",
      authorization: `Basic ${btoa("ocpp:first")}`,
    },
    {
      url: "http://127.0.0.1:4200/api/health",
      authorization: `Basic ${btoa("ocpp:second")}`,
    },
  ])
})
