import fs from "node:fs/promises"
import path from "node:path"
import { expect } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { startServer } from "./fixture/server"

it.live("lists session drivers and selects one through the session model", () =>
  Effect.gen(function* () {
    const tmp = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("ocpp-driver-endpoint-")))
    // Disabled vendors are reported without launching a vendor CLI.
    yield* Effect.promise(() =>
      fs.writeFile(
        path.join(tmp.path, "ocpp.json"),
        JSON.stringify({
          external_agents: {
            claude: { enabled: false, model: "opus" },
            codex: { enabled: false },
            pi: { enabled: false },
          },
        }),
      ),
    )
    const server = yield* startServer(tmp.path)
    const call = (route: string, init?: { method: string; body?: unknown }) =>
      Effect.promise(async () => {
        const url = new URL(route, server.base)
        if (init === undefined) url.searchParams.set("location[directory]", tmp.path)
        const response = await fetch(url, {
          method: init?.method ?? "GET",
          headers: { "content-type": "application/json" },
          ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        })
        return { status: response.status, body: response.status === 204 ? undefined : await response.json() }
      })

    const drivers = yield* call("/api/model/driver")
    expect(drivers.status).toBe(200)
    expect(drivers.body.data).toEqual([
      expect.objectContaining({ id: "claude", name: "Claude Code", available: false, model: "opus" }),
      expect.objectContaining({ id: "codex", name: "Codex", available: false, model: "sol" }),
      expect.objectContaining({ id: "pi", name: "Pi", available: false }),
    ])
    expect(drivers.body.data[0].models).toEqual(["opus", "sonnet", "haiku", "fable"])
    expect(drivers.body.data[0].variants).toContain("high")

    const created = yield* call("/api/session", {
      method: "POST",
      body: { location: { directory: tmp.path }, model: { providerID: "claude", id: "opus", variant: "high" } },
    })
    expect(created.status).toBe(200)
    const sessionID = created.body.data.id
    expect(created.body.data.model).toEqual({ providerID: "claude", id: "opus", variant: "high" })

    expect((yield* call(`/api/session/${sessionID}/prompt`, { method: "POST", body: { text: "Hello" } })).status).toBe(
      200,
    )
    yield* call(`/api/session/${sessionID}/wait`, { method: "POST" })
    const session = yield* call(`/api/session/${sessionID}`, { method: "GET" })
    // The Claude Code driver ran and reported that it is disabled here, instead of calling a model provider.
    expect(session.body.data.outcome).toBe("failed")
  }),
)
