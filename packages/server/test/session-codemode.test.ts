import { expect } from "bun:test"
import { Effect } from "effect"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

it.live("lists a session's commands and events", () =>
  Effect.gen(function* () {
    const handler = yield* ServerFetch.make({
      app: { version: "test-version" },
      database: { path: ":memory:" },
      fs: { filewatcher: false },
    })
    const request = (path: string, init?: RequestInit) =>
      Effect.promise(() => handler(new Request(`http://ocpp.local${path}`, init)))
    const created = yield* request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).pipe(Effect.flatMap((response) => Effect.promise(() => response.json())))

    const commands = yield* request(`/api/session/${created.data.id}/command`)
    expect(commands.status).toBe(200)
    expect(yield* Effect.promise(() => commands.json())).toEqual({ data: [] })
    const events = yield* request(`/api/session/${created.data.id}/event`)
    expect(events.status).toBe(200)
    expect(yield* Effect.promise(() => events.json())).toEqual({ data: [] })
    expect((yield* request("/api/session/ses_missing/command")).status).toBe(404)
    expect((yield* request("/api/session/ses_missing/event")).status).toBe(404)
  }),
)
