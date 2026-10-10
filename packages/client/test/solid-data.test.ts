import { expect, test } from "bun:test"
import { getEventListeners } from "node:events"
import { createRoot } from "solid-js"
import { createData, type CreateDataInput } from "../src/solid"
import { Ocpp, type OcppEvent, type Project, type SessionInfo } from "../src/promise"

const session = (viewed: number): SessionInfo => ({
  id: "ses_refresh",
  projectID: "project",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  outcome: "succeeded",
  time: { created: 0, updated: 0, idle: 2, viewed },
  location: { directory: "/project" },
})

test("revalidates after an event overtakes an active session read", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  let requests = 0
  const api = Ocpp.make({
    baseUrl: "http://ocpp.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.endsWith("/api/session/ses_refresh")) throw new Error(`Unexpected request: ${request.url}`)
      requests++
      if (requests === 1) {
        await gate
        return Response.json({ data: session(1) })
      }
      return Response.json({ data: session(2) })
    },
  })
  const event: CreateDataInput["event"] = {
    on:
      <Type extends OcppEvent["type"]>(_type: Type, _handler: (event: Extract<OcppEvent, { type: Type }>) => void) =>
      () => {},
    listen(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  }
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event, connection: { status: () => "connected" } }),
    dispose,
  }))

  try {
    setup.data.session.remember(session(1))
    setup.data.session.invalidate("ses_refresh")
    const initial = setup.data.session.sync("ses_refresh")
    await wait(() => requests === 1)

    const viewed: OcppEvent = {
      id: "evt_viewed",
      created: 2,
      type: "session-viewed",
      durable: { aggregateID: "ses_refresh", seq: 1 },
      data: { sessionID: "ses_refresh", idle: 2 },
    }
    listeners.forEach((listener) => listener({ name: viewed.type, details: viewed }))
    await Bun.sleep(20)
    release()
    await initial

    await wait(() => requests === 2 && setup.data.session.get("ses_refresh")?.time.viewed === 2)
  } finally {
    setup.dispose()
  }
})

test("updates authoritative cached project metadata from live events", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const original: Project = {
    id: "project_renamed",
    canonical: "/projects/original",
    name: "Original custom name",
    time: { created: 1, updated: 1 },
    sandboxes: [],
  }
  const unrelated: Project = {
    id: "project_unrelated",
    canonical: "/projects/unrelated",
    name: "Unrelated project",
    time: { created: 1, updated: 1 },
    sandboxes: [],
  }
  let requests = 0
  const api = Ocpp.make({
    baseUrl: "http://ocpp.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.endsWith("/api/project")) throw new Error(`Unexpected request: ${request.url}`)
      requests++
      return Response.json([original, unrelated])
    },
  })
  const event: CreateDataInput["event"] = {
    on: () => () => {},
    listen(handler) {
      listeners.add(handler)
      return () => listeners.delete(handler)
    },
  }
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/projects/original", event }),
    dispose,
  }))

  try {
    await setup.data.project.sync()
    expect(setup.data.project.get(original.id)).toEqual(original)

    const updated: OcppEvent = {
      id: "evt_project_renamed",
      created: 2,
      type: "project-updated",
      data: {
        ...original,
        canonical: "/projects/renamed",
        name: "Updated custom name",
        time: { ...original.time, updated: 2 },
      },
    }
    listeners.forEach((listener) => listener({ name: updated.type, details: updated }))

    expect(setup.data.project.get(original.id)?.canonical).toBe("/projects/renamed")
    expect(setup.data.project.get(original.id)?.name).toBe("Updated custom name")
    expect(setup.data.project.get(unrelated.id)).toEqual(unrelated)
    expect(requests).toBe(1)

    const reset: OcppEvent = {
      id: "evt_project_name_reset",
      created: 3,
      type: "project-updated",
      data: {
        id: original.id,
        canonical: "/projects/renamed-again",
        time: { ...original.time, updated: 3 },
        sandboxes: [],
      },
    }
    listeners.forEach((listener) => listener({ name: reset.type, details: reset }))

    expect(setup.data.project.get(original.id)?.canonical).toBe("/projects/renamed-again")
    expect(setup.data.project.get(original.id)?.name).toBeUndefined()
    expect(setup.data.project.get(unrelated.id)).toEqual(unrelated)
    expect(requests).toBe(1)
  } finally {
    setup.dispose()
  }
})

test("adopts cached directory-project sessions when their repository is resolved", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const refreshed: SessionInfo = {
    ...session(0),
    id: "ses_uncached",
    projectID: "repository",
    location: { directory: "/unknown-alias" },
    subpath: "app",
  }
  const api = Ocpp.make({
    baseUrl: "http://ocpp.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.endsWith("/api/session/ses_uncached")) throw new Error(`Unexpected request: ${request.url}`)
      return Response.json({ data: refreshed })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/repo",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    dispose,
  }))

  try {
    const sessions: SessionInfo[] = [
      { ...session(0), id: "ses_root", projectID: "directory-root", location: { directory: "/repo" } },
      { ...session(0), id: "ses_nested", projectID: "directory-nested", location: { directory: "/repo/app" } },
      {
        ...session(0),
        id: "ses_alias",
        projectID: "directory-nested",
        location: { directory: "/repo/alias/../app" },
      },
      { ...session(0), id: "ses_symlink", projectID: "directory-nested", location: { directory: "/shortcut" } },
      { ...refreshed, projectID: "directory-uncached" },
      { ...session(0), id: "ses_global", projectID: "global", location: { directory: "/repo/legacy" } },
      { ...session(0), id: "ses_escaped", projectID: "global", location: { directory: "/repo/../other" } },
      { ...session(0), id: "ses_other", projectID: "other-repository", location: { directory: "/repo/vendor" } },
      { ...session(0), id: "ses_sibling", projectID: "global", location: { directory: "/repo-other" } },
      {
        ...session(0),
        id: "ses_remote",
        projectID: "directory-root",
        location: { directory: "/repo", workspaceID: "workspace-remote" },
      },
    ]
    sessions.forEach((item) => setup.data.session.remember(item))
    for (const project of [
      { id: "directory-root", canonical: "/repo" },
      { id: "directory-nested", canonical: "/repo/app" },
    ]) {
      const updated: OcppEvent = {
        id: `evt_${project.id}`,
        created: 0,
        type: "project-updated",
        data: { ...project, time: { created: 0, updated: 0 }, sandboxes: [] },
      }
      listeners.forEach((listener) => listener({ name: updated.type, details: updated }))
    }

    const resolved: OcppEvent = {
      id: "evt_repository_resolved",
      created: 1,
      type: "worktree-resolved",
      durable: { aggregateID: "repository", seq: 0 },
      data: {
        projectID: "repository",
        directory: "/repo",
        previous: "global",
        adopted: ["directory-root", "directory-nested", "directory-uncached"],
      },
    }
    listeners.forEach((listener) => listener({ name: resolved.type, details: resolved }))

    expect(setup.data.session.get("ses_root")?.projectID).toBe("repository")
    expect(setup.data.session.get("ses_root")?.subpath).toBeUndefined()
    expect(setup.data.session.get("ses_nested")).toMatchObject({ projectID: "repository", subpath: "app" })
    expect(setup.data.session.get("ses_alias")).toMatchObject({ projectID: "repository", subpath: "app" })
    expect(setup.data.session.get("ses_symlink")).toMatchObject({ projectID: "repository", subpath: "app" })
    expect(setup.data.session.get("ses_global")).toMatchObject({ projectID: "repository", subpath: "legacy" })
    expect(setup.data.session.get("ses_escaped")?.projectID).toBe("global")
    expect(setup.data.session.get("ses_other")?.projectID).toBe("other-repository")
    expect(setup.data.session.get("ses_sibling")?.projectID).toBe("global")
    expect(setup.data.session.get("ses_remote")?.projectID).toBe("directory-root")
    await wait(() => setup.data.session.get("ses_uncached")?.projectID === "repository")
    expect(setup.data.session.get("ses_uncached")?.subpath).toBe("app")
  } finally {
    setup.dispose()
  }
})

test("refreshes global credential events across every loaded location and workspace", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const requests: URL[] = []
  const api = Ocpp.make({
    baseUrl: "http://ocpp.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      requests.push(url)
      const directory = url.searchParams.get("location[directory]") ?? "/project"
      return Response.json({
        location: {
          directory,
          workspaceID: url.searchParams.get("location[workspace]") ?? undefined,
          project: { id: "project", directory, canonical: directory },
        },
        data: [],
      })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
      connection: { status: () => "connected" },
    }),
    dispose,
  }))
  const locations = [{ directory: "/project" }, { directory: "/other", workspaceID: "workspace-other" }]

  try {
    await Promise.all(
      locations.flatMap((location) => [
        setup.data.location.integration.sync(location),
        setup.data.location.model.sync(location),
        setup.data.location.provider.sync(location),
      ]),
    )
    requests.length = 0

    const updated: OcppEvent = {
      id: "evt_credential.updated",
      created: 1,
      type: "credential-updated",
      data: {},
    }
    listeners.forEach((listener) => listener({ name: updated.type, details: updated }))
    await wait(() => requests.length === 2)
    expect(
      requests.map((url) => [
        url.pathname,
        url.searchParams.get("location[directory]"),
        url.searchParams.get("location[workspace]"),
      ]),
    ).toEqual([
      ["/api/integration", "/project", null],
      ["/api/integration", "/other", "workspace-other"],
    ])
    requests.length = 0

    for (const credentialID of ["credential", null]) {
      const switched: OcppEvent = {
        id: `evt_credential.switched.${credentialID}`,
        created: 2,
        type: "credential-switched",
        data: { credentialID, integrationID: "integration" },
      }
      listeners.forEach((listener) => listener({ name: switched.type, details: switched }))
      await wait(() => requests.length === 4)
      expect(
        requests.map((url) => [
          url.pathname,
          url.searchParams.get("location[directory]"),
          url.searchParams.get("location[workspace]"),
        ]),
      ).toEqual(
        expect.arrayContaining([
          ["/api/model", "/project", null],
          ["/api/provider", "/project", null],
          ["/api/model", "/other", "workspace-other"],
          ["/api/provider", "/other", "workspace-other"],
        ]),
      )
      requests.length = 0
    }
  } finally {
    setup.dispose()
  }
})

test("reloads a location's config when it changes", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const models = ["demo", "claude"]
  const api = Ocpp.make({
    baseUrl: "http://ocpp.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      if (url.pathname !== "/api/config") return Response.json({ location: { directory: "/project" }, data: [] })
      expect(url.searchParams.get("location[directory]")).toBe("/project")
      return Response.json([
        { type: "document", path: "/project/ocpp.json", info: { model: { providerID: models[0], model: "m" } } },
      ])
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
      connection: { status: () => "connected" },
    }),
    dispose,
  }))
  const location = { directory: "/project" }
  const configured = () => {
    const entry = setup.data.location.config.list(location)?.[0]
    return entry?.type === "document" && typeof entry.info.model === "object" ? entry.info.model.providerID : undefined
  }

  try {
    await setup.data.location.config.sync(location)
    expect(configured()).toBe("demo")

    models.shift()
    const updated: OcppEvent = { id: "evt_config.updated", created: 1, type: "config-updated", location, data: {} }
    listeners.forEach((listener) => listener({ name: updated.type, details: updated }))
    await wait(() => configured() === "claude")
  } finally {
    setup.dispose()
  }
})

test("reports optimistic sessions as creating until the request settles", async () => {
  const release = Promise.withResolvers<void>()
  const api = Ocpp.make({
    baseUrl: "http://ocpp.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (!request.url.endsWith("/api/session")) throw new Error(`Unexpected request: ${request.url}`)
      await release.promise
      return Response.json({ data: session(0) })
    },
  })
  const event: CreateDataInput["event"] = {
    on: () => () => {},
    listen: () => () => {},
  }
  const setup = createRoot((dispose) => ({
    data: createData({ api: () => api, directory: "/project", event, connection: { status: () => "connected" } }),
    dispose,
  }))

  try {
    const created = setup.data.session.create({ id: "ses_refresh", location: { directory: "/project" } })
    expect(setup.data.session.creating(created.id)).toBe(true)
    release.resolve()
    await created.request
    expect(setup.data.session.creating(created.id)).toBe(false)
  } finally {
    setup.dispose()
  }
})

test("preserves a fast Code Mode terminal across outer tool success", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const assistant = {
    id: "msg_codemode",
    type: "assistant",
    agent: "build",
    model: { id: "model", providerID: "provider" },
    time: { created: 1 },
    content: [
      {
        type: "tool",
        id: "call_codemode",
        name: "execute",
        time: { created: 1, ran: 1 },
        state: { status: "running", input: { code: "return 1" }, metadata: {} },
      },
    ],
  }
  const api = Ocpp.make({
    baseUrl: "http://ocpp.local",
    fetch: async () => Response.json({ data: [assistant], cursor: {} }),
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

  try {
    await setup.data.session.message.sync("ses_codemode")
    const publish = (details: OcppEvent) => listeners.forEach((listener) => listener({ name: details.type, details }))
    publish({
      id: "evt_codemode_completed",
      created: 2,
      type: "session-codemode-completed",
      durable: { aggregateID: "ses_codemode", seq: 1 },
      data: {
        sessionID: "ses_codemode",
        assistantMessageID: assistant.id,
        id: "call_codemode",
        executionID: "exe_codemode",
        events: [{ type: "trace", kind: "return", value: "1" }],
      },
    })
    publish({
      id: "evt_tool_success",
      created: 3,
      type: "session-tool-settled",
      durable: { aggregateID: "ses_codemode", seq: 2 },
      data: {
        sessionID: "ses_codemode",
        assistantMessageID: assistant.id,
        id: "call_codemode",
        content: [{ type: "text", text: "Code Mode execution started." }],
        metadata: { executionID: "exe_codemode", executionStatus: "running", events: [] },
        executed: false,
        outcome: "succeeded",
      },
    })

    const message = setup.data.session.message.get("ses_codemode", assistant.id)
    expect(message?.type).toBe("assistant")
    if (message?.type !== "assistant") throw new Error("Assistant message is unavailable")
    expect(message.content[0]).toMatchObject({
      type: "tool",
      state: {
        status: "completed",
        metadata: {
          executionID: "exe_codemode",
          executionStatus: "completed",
          events: [{ type: "trace", kind: "return", value: "1" }],
        },
      },
    })
  } finally {
    setup.dispose()
  }
})

test("refreshes a loaded Code Mode terminal after reconnect misses its event", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  let failed = false
  let requests = 0
  const api = Ocpp.make({
    baseUrl: "http://ocpp.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const path = new URL(request.url).pathname
      if (path === "/api/session/active") return Response.json({ data: {} })
      if (path === "/api/project") return Response.json([])
      if (path === "/api/location") return Response.json({ directory: "/project" })
      if (path === "/api/vcs") return Response.json({ location: { directory: "/project" }, data: { branch: "main" } })
      if (path !== "/api/session/ses_codemode/message") throw new Error("Unexpected request: " + path)
      requests++
      return Response.json({
        data: [
          {
            id: "msg_codemode",
            type: "assistant",
            agent: "build",
            model: { id: "model", providerID: "provider" },
            time: { created: 1 },
            content: [
              {
                type: "tool",
                id: "call_codemode",
                name: "execute",
                time: { created: 1, ran: 1 },
                state: {
                  status: "completed",
                  input: { code: "return await tools.shell({ command: 'sleep 60' })" },
                  content: [{ type: "text", text: "Code Mode execution started." }],
                  metadata: failed
                    ? {
                        executionID: "exe_codemode",
                        executionStatus: "error",
                        events: [],
                        error: "Execution failed because the server restarted.",
                      }
                    : { executionID: "exe_codemode", executionStatus: "running", events: [] },
                },
              },
            ],
          },
        ],
        cursor: {},
      })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    dispose,
  }))
  const connected = { type: "server-connected", data: {} } satisfies OcppEvent
  const executionStatus = () => {
    const message = setup.data.session.message.get("ses_codemode", "msg_codemode")
    if (message?.type !== "assistant") return
    const tool = message.content[0]
    if (tool?.type !== "tool") return
    return tool.state.metadata.executionStatus
  }

  try {
    listeners.forEach((listener) => listener({ name: connected.type, details: connected }))
    await setup.data.session.message.sync("ses_codemode")
    expect(requests).toBe(1)
    expect(setup.data.session.message.get("ses_codemode", "msg_codemode")).toMatchObject({
      content: [{ state: { metadata: { executionStatus: "running" } } }],
    })

    failed = true
    listeners.forEach((listener) => listener({ name: connected.type, details: connected }))

    await wait(() => executionStatus() === "error")
    expect(requests).toBe(2)
    expect(setup.data.session.message.get("ses_codemode", "msg_codemode")).toMatchObject({
      content: [
        {
          state: {
            metadata: {
              executionStatus: "error",
              error: "Execution failed because the server restarted.",
            },
          },
        },
      ],
    })
  } finally {
    setup.dispose()
  }
})

test("loads bounded message pages", async () => {
  const requests: URL[] = []
  const api = Ocpp.make({
    baseUrl: "http://ocpp.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const url = new URL(request.url)
      requests.push(url)
      return Response.json({ data: [], cursor: requests.length === 1 ? { next: "next" } : {} })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: { on: () => () => {}, listen: () => () => {} },
    }),
    dispose,
  }))

  try {
    await setup.data.session.message.sync("ses_refresh")
    await setup.data.session.message.loadMore("ses_refresh")

    expect(requests).toHaveLength(2)
    expect(Object.fromEntries(requests[0].searchParams)).toEqual({ limit: "20", order: "desc" })
    expect(Object.fromEntries(requests[1].searchParams)).toEqual({ cursor: "next", limit: "20" })
  } finally {
    setup.dispose()
  }
})

test.each(["success", "failure", "cancel", "cancel-retry", "cancel-page", "join-cancel", "join-failure"])(
  "bulk history (%s)",
  async (mode) => {
    const messages = [1, 2, 3].map((index) => ({
      id: `msg_${index}`,
      type: "user",
      text: `Message ${index}`,
      time: { created: index },
    }))
    const release = Promise.withResolvers<void>()
    const controller = new AbortController()
    const requests: URL[] = []
    const publications: string[][] = []
    const api = Ocpp.make({
      baseUrl: "http://ocpp.local",
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input))
        requests.push(url)
        const cursor = url.searchParams.get("cursor")
        if (!cursor) return Response.json({ data: [messages[2]], cursor: { next: "recent" } })
        if (cursor === "recent") {
          if (mode.startsWith("join")) await release.promise
          if (mode === "join-failure") return Response.json({ message: "offline" }, { status: 503 })
          return Response.json({ data: [messages[2], messages[1]], cursor: { next: "oldest" } })
        }
        if (cursor === "oldest") return Response.json({ data: [messages[0]], cursor: { next: "empty" } })
        expect(init?.signal).toBe(requests.length === 4 ? controller.signal : undefined)
        await release.promise
        if (mode === "failure") return Response.json({ message: "offline" }, { status: 503 })
        return Response.json({ data: [], cursor: {} })
      },
    })
    const setup = createRoot((dispose) => {
      const data = createData({
        api: () => api,
        directory: "/project",
        event: { on: () => () => {}, listen: () => () => {} },
      })
      return { data, dispose }
    })

    try {
      await setup.data.session.message.sync("ses_refresh")
      const newest = setup.data.session.message.get("ses_refresh", "msg_3")
      const load = setup.data.session.message.loadMore(
        "ses_refresh",
        mode.startsWith("join")
          ? undefined
          : {
              all: true,
              signal: controller.signal,
              beforePublish: () => {
                publications.push(setup.data.session.message.list("ses_refresh").map((message) => message.id))
                expect(setup.data.session.message.get("ses_refresh", "msg_3")).toBe(newest)
              },
            },
      )
      const joined = setup.data.session.message.loadMore("ses_refresh", { all: true, signal: controller.signal })
      const settled = Promise.allSettled([load, joined])
      if (mode.startsWith("join")) {
        await wait(() => requests.length === 2)
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(1)
        controller.abort()
        let cancelled = false
        void joined.then(() => {
          cancelled = true
        })
        await wait(() => cancelled)
        expect(setup.data.session.message.loading("ses_refresh")).toBe(true)
        expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
        release.resolve()
        expect((await settled).map((result) => result.status)).toEqual(
          mode === "join-failure" ? ["rejected", "fulfilled"] : ["fulfilled", "fulfilled"],
        )
        expect(requests.at(-1)?.searchParams.get("limit")).toBe("20")
        expect(requests).toHaveLength(2)
        expect(setup.data.session.message.more("ses_refresh")).toBe(true)
        expect(setup.data.session.message.list("ses_refresh").map((message) => message.id)).toEqual(
          mode === "join-failure" ? ["msg_3"] : ["msg_2", "msg_3"],
        )
        return
      }
      await wait(() => requests.length === 4)
      expect(setup.data.session.message.loading("ses_refresh")).toBe(true)
      expect(setup.data.session.message.list("ses_refresh").map((message) => message.id)).toEqual(["msg_3"])
      expect(requests.slice(1).map((url) => url.searchParams.get("limit"))).toEqual(["200", "200", "200"])
      if (mode.startsWith("cancel")) controller.abort()
      const retry =
        mode === "cancel-retry" || mode === "cancel-page"
          ? setup.data.session.message.loadMore("ses_refresh", mode === "cancel-retry" ? { all: true } : undefined)
          : undefined
      release.resolve()
      expect((await settled).map((result) => result.status)).toEqual(
        mode === "failure" ? ["rejected", "rejected"] : ["fulfilled", "fulfilled"],
      )
      await retry
      const success = mode === "success" || mode === "cancel-retry"
      expect(setup.data.session.message.loading("ses_refresh")).toBe(false)
      expect(setup.data.session.message.more("ses_refresh")).toBe(!success)
      expect(setup.data.session.message.list("ses_refresh").map((message) => message.id)).toEqual(
        success ? ["msg_1", "msg_2", "msg_3"] : mode === "cancel-page" ? ["msg_2", "msg_3"] : ["msg_3"],
      )
      expect(setup.data.session.message.get("ses_refresh", "msg_3")).toBe(newest)
      expect(requests).toHaveLength(mode === "cancel-retry" ? 7 : mode === "cancel-page" ? 5 : 4)
      if (mode === "cancel-page") expect(requests.at(-1)?.searchParams.get("limit")).toBe("20")
      expect(publications).toEqual(mode === "success" ? [["msg_3"]] : [])
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
    } finally {
      release.resolve()
      setup.dispose()
    }
  },
)

test("preserves assistant content replacement events across an active message read", async () => {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const release = Promise.withResolvers<void>()
  let requests = 0
  const content = [
    { type: "text" as const, text: "replacement" },
    { type: "reasoning" as const, text: "reasoning", time: { created: 3 } },
  ]
  const api = Ocpp.make({
    baseUrl: "http://ocpp.local",
    fetch: async () => {
      const current = ++requests
      if (current === 2) await release.promise
      return Response.json({
        data: [
          {
            id: "msg_assistant",
            type: "assistant",
            agent: "build",
            model: { id: "model", providerID: "provider" },
            content: current === 3 ? content : [{ type: "text", text: "original" }],
            time: { created: 1, completed: 2 },
          },
        ],
        cursor: {},
      })
    },
  })
  const setup = createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    dispose,
  }))

  try {
    await setup.data.session.message.sync("ses_refresh")
    setup.data.session.message.invalidate("ses_refresh")
    const stale = setup.data.session.message.sync("ses_refresh")
    await wait(() => requests === 2)
    const updated: OcppEvent = {
      id: "evt_message_updated",
      created: 3,
      type: "session-message-content-updated",
      durable: { aggregateID: "ses_refresh", seq: 3 },
      data: {
        sessionID: "ses_refresh",
        messageID: "msg_assistant",
        content,
      },
    }
    listeners.forEach((listener) => listener({ name: updated.type, details: updated }))

    expect(setup.data.session.message.list("ses_refresh")[0]).toMatchObject({ content })
    release.resolve()
    await stale
    await wait(() => requests === 3)
    expect(setup.data.session.message.list("ses_refresh")[0]).toMatchObject({ content })
  } finally {
    setup.dispose()
  }
})

test.each([
  ["session-execution-settled", "succeeded"],
  ["session-execution-settled", "failed"],
  ["session-execution-settled", "interrupted"],
  ["session-execution-started", undefined],
  ["session-deleted", undefined],
] as const)("preserves %s %s activity when an older snapshot arrives", async (type, outcome) => {
  const release = Promise.withResolvers<void>()
  const requested = Promise.withResolvers<void>()
  const setup = activityFixture(async () => {
    requested.resolve()
    await release.promise
    return Response.json({
      data: {
        ...(type === "session-execution-started" ? {} : { ses_refresh: { type: "running" } }),
        ses_hydrated: { type: "running" },
      },
    })
  })

  try {
    if (type !== "session-execution-started") setup.data.session.setStatus("ses_refresh", "running")
    setup.emit({ type: "server-connected", data: {} })
    await requested.promise
    setup.emit({
      id: "evt_activity",
      created: 2,
      type,
      durable: { aggregateID: "ses_refresh", seq: 2 },
      data: {
        sessionID: "ses_refresh",
        ...(outcome === undefined ? {} : { outcome }),
        ...(outcome === "failed" ? { error: { type: "unknown", message: "failed" } } : { reason: "user" }),
      },
    } as OcppEvent)
    expect(setup.data.session.status("ses_refresh")).toBe(type === "session-execution-started" ? "running" : "idle")
    release.resolve()
    await wait(() => setup.data.session.status("ses_hydrated") === "running")
    expect(setup.data.session.status("ses_refresh")).toBe(type === "session-execution-started" ? "running" : "idle")
  } finally {
    release.resolve()
    setup.dispose()
  }
})

test("ignores activity snapshots from an older connection", async () => {
  const reads: ReturnType<typeof Promise.withResolvers<Response>>[] = []
  const setup = activityFixture(() => {
    const read = Promise.withResolvers<Response>()
    reads.push(read)
    return read.promise
  })

  try {
    setup.emit({ type: "server-connected", data: {} })
    await wait(() => reads.length === 1)
    setup.emit({ type: "server-connected", data: {} })
    await wait(() => reads.length === 2)
    reads[1]?.resolve(Response.json({ data: { ses_new: { type: "running" } } }))
    await wait(() => setup.data.session.status("ses_new") === "running")
    reads[0]?.resolve(Response.json({ data: { ses_old: { type: "running" } } }))
    await Bun.sleep(20)
    expect(setup.data.session.status("ses_new")).toBe("running")
    expect(setup.data.session.status("ses_old")).toBe("idle")
  } finally {
    reads.forEach((read) => read.resolve(Response.json({ data: {} })))
    setup.dispose()
  }
})

test("projects a background user shell from its start and its settlement", () => {
  const setup = activityFixture(() => Response.json({ data: {} }))
  try {
    setup.emit({
      id: "evt_user_shell",
      created: 1,
      type: "session-shell-started",
      durable: { aggregateID: "ses_refresh", seq: 1 },
      data: {
        sessionID: "ses_refresh",
        shell: {
          id: "sh_user",
          status: "running",
          command: "pwd",
          cwd: "/project",
          shell: "/bin/sh",
          file: "/project/shell.out",
          metadata: { sessionID: "ses_refresh", background: true },
          time: { started: 1 },
        },
      },
    })
    expect(setup.data.session.message.list("ses_refresh")).toMatchObject([
      { type: "shell", shellID: "sh_user", status: "running", metadata: { background: true } },
    ])
    setup.emit({
      id: "evt_user_shell_settled",
      created: 2,
      type: "session-shell-settled",
      durable: { aggregateID: "ses_refresh", seq: 2 },
      data: {
        sessionID: "ses_refresh",
        shellID: "sh_user",
        outcome: "exited",
        exit: 0,
        output: { output: "/project", cursor: 8, size: 8, truncated: false },
      },
    })
    expect(setup.data.session.message.list("ses_refresh")).toMatchObject([
      {
        type: "shell",
        shellID: "sh_user",
        status: "exited",
        exit: 0,
        output: { output: "/project" },
        time: { completed: 2 },
      },
    ])
  } finally {
    setup.dispose()
  }
})

test("renders blocks and tool input while they stream, then the recorded facts", () => {
  const setup = activityFixture(() => Response.json({ data: {} }))
  const sessionID = "ses_stream"
  const assistantMessageID = "msg_stream"
  let seq = 0
  let created = 0
  const durable = () => ({ aggregateID: sessionID, seq: seq++ })
  const live = () => ({ id: `evt_live_${created}`, created: ++created })
  const message = () => {
    const found = setup.data.session.message.get(sessionID, assistantMessageID)
    if (found?.type !== "assistant") throw new Error("Assistant message is unavailable")
    return found
  }
  const block = { sessionID, assistantMessageID, ordinal: 0 }
  try {
    setup.emit({
      ...live(),
      type: "session-step-started",
      durable: durable(),
      data: { sessionID, assistantMessageID, agent: "build", model: { id: "model", providerID: "provider" } },
    })
    setup.emit({ ...live(), type: "session-block-started", data: { ...block, kind: "reasoning" } })
    setup.emit({ ...live(), type: "session-block-delta", data: { ...block, kind: "reasoning", delta: "Think" } })
    expect(message().content).toMatchObject([{ type: "reasoning", text: "Think" }])
    expect(message().content[0]).not.toHaveProperty("time.completed")
    setup.emit({ ...live(), type: "session-block-started", data: { ...block, kind: "text" } })
    setup.emit({ ...live(), type: "session-block-delta", data: { ...block, kind: "text", delta: "Hel" } })
    setup.emit({ ...live(), type: "session-block-delta", data: { ...block, kind: "text", delta: "lo" } })
    // Streaming text shows while the reasoning block is still open.
    expect(message().content).toMatchObject([
      { type: "reasoning", text: "Think" },
      { type: "text", text: "Hello" },
    ])
    setup.emit({
      ...live(),
      type: "session-block-recorded",
      durable: durable(),
      data: { ...block, kind: "reasoning", text: "Thinking", state: { signature: "signed" } },
    })
    setup.emit({
      ...live(),
      type: "session-block-recorded",
      durable: durable(),
      data: { ...block, kind: "text", text: "Hello!" },
    })
    expect(message().content).toMatchObject([
      { type: "reasoning", text: "Thinking", state: { signature: "signed" }, time: { completed: expect.any(Number) } },
      { type: "text", text: "Hello!" },
    ])

    setup.emit({
      ...live(),
      type: "session-tool-input-started",
      data: { sessionID, assistantMessageID, id: "call_read", name: "read" },
    })
    setup.emit({
      ...live(),
      type: "session-tool-input-delta",
      data: { sessionID, assistantMessageID, id: "call_read", delta: '{"path":' },
    })
    expect(message().content[2]).toMatchObject({
      type: "tool",
      name: "read",
      state: { status: "streaming", input: '{"path":' },
    })
    setup.emit({
      ...live(),
      type: "session-tool-requested",
      durable: durable(),
      data: { sessionID, assistantMessageID, id: "call_read", name: "read", input: { path: "a.txt" }, executed: false },
    })
    expect(message().content).toHaveLength(3)
    expect(message().content[2]).toMatchObject({ state: { status: "running", input: { path: "a.txt" } } })
    setup.emit({
      ...live(),
      type: "session-tool-settled",
      durable: durable(),
      data: {
        sessionID,
        assistantMessageID,
        id: "call_read",
        outcome: "succeeded",
        content: [{ type: "text", text: "contents" }],
        executed: false,
      },
    })
    expect(message().content[2]).toMatchObject({ state: { status: "completed" } })

    // A block whose start was missed starts with its first delta; one that never streamed here is added whole.
    setup.emit({ ...live(), type: "session-block-delta", data: { ...block, ordinal: 1, kind: "text", delta: "Late" } })
    setup.emit({
      ...live(),
      type: "session-block-recorded",
      durable: durable(),
      data: { ...block, ordinal: 1, kind: "text", text: "Later" },
    })
    setup.emit({
      ...live(),
      type: "session-block-recorded",
      durable: durable(),
      data: { ...block, ordinal: 2, kind: "text", text: "Whole" },
    })
    expect(message().content.slice(3)).toMatchObject([
      { type: "text", text: "Later" },
      { type: "text", text: "Whole" },
    ])
  } finally {
    setup.dispose()
  }
})

function activityFixture(read: () => Response | Promise<Response>) {
  const listeners = new Set<Parameters<CreateDataInput["event"]["listen"]>[0]>()
  const api = Ocpp.make({
    baseUrl: "http://ocpp.local",
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init)
      const path = new URL(request.url).pathname
      if (path === "/api/session/active") return read()
      if (path === "/api/project") return Response.json([])
      if (path === "/api/location") return Response.json({ directory: "/project" })
      return Response.json({ location: { directory: "/project" }, data: { branch: "main" } })
    },
  })
  return createRoot((dispose) => ({
    data: createData({
      api: () => api,
      directory: "/project",
      event: {
        on: () => () => {},
        listen(handler) {
          listeners.add(handler)
          return () => listeners.delete(handler)
        },
      },
    }),
    emit: (details: OcppEvent) => listeners.forEach((listener) => listener({ name: details.type, details })),
    dispose,
  }))
}

async function wait(check: () => boolean) {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > 2_000) throw new Error("Timed out waiting for condition")
    await Bun.sleep(10)
  }
}
