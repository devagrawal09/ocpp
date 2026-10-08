import { Database } from "bun:sqlite"
import { expect } from "bun:test"
import path from "node:path"
import { Effect } from "effect"
import { HttpServer, HttpServerError, HttpServerResponse } from "effect/http"
import { it } from "../../core/test/lib/effect"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { ServerProcess } from "../src/process"

it.live("recovers durable background work for a foreground server", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped("ocpp-server-process-")
    const filename = path.join(directory.path, "process.db")
    const options = {
      hostname: "127.0.0.1",
      port: 0,
      database: { path: filename },
    }
    yield* ServerProcess.start<never, never>(options)

    const database = new Database(filename)
    yield* Effect.addFinalizer(() => Effect.sync(() => database.close()))
    const key = "job.background/msg_process_restart"
    const now = Date.now()
    database.query("insert into kv (key, value, time_created, time_updated) values (?, ?, ?, ?)").run(
      key,
      JSON.stringify({
        id: "exe_process_restart",
        notificationID: "msg_process_restart",
        recovery: {
          kind: "codemode",
          parentSessionID: "ses_process_restart_missing",
          assistantMessageID: "msg_process_restart_assistant",
          toolCallID: "call_process_restart",
          code: "return 1",
          timeoutMs: 1_000,
        },
        status: "running",
      }),
      now,
      now,
    )

    yield* ServerProcess.start<never, never>(options)
    yield* waitForMarkerRemoval(database, key)
  }),
)

it.live("allows browser preflight requests without credentials", () =>
  Effect.gen(function* () {
    const fallback = "fallback".repeat(256)
    const server = yield* ServerProcess.start<never, never>(
      {
        hostname: "127.0.0.1",
        port: 0,
        cors: ["http://192.168.1.10:3001", "https://example.com"],
        app: { version: "test-version" },
        database: { path: ":memory:" },
      },
      undefined,
      (api) =>
        api.pipe(
          Effect.catchIf(
            (error) => error instanceof HttpServerError.HttpServerError && error.reason._tag === "RouteNotFound",
            () => Effect.succeed(HttpServerResponse.raw(fallback, { contentType: "text/plain" })),
          ),
        ),
    )
    const response = yield* Effect.promise(() =>
      fetch(new URL("/api/health", HttpServer.formatAddress(server.address)), {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:3000",
          "access-control-request-method": "GET",
          "access-control-request-headers": "content-type",
        },
      }),
    )

    expect(response.status).toBe(204)
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    expect(response.headers.get("access-control-allow-headers")).toBe("content-type")

    const health = yield* Effect.promise(() =>
      fetch(new URL("/api/health", HttpServer.formatAddress(server.address)), {
        headers: { origin: "http://localhost:3000" },
      }),
    )

    expect(health.status).toBe(200)
    expect(health.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
    expect(yield* Effect.promise(() => health.json())).toMatchObject({ version: "test-version" })

    yield* Effect.forEach(
      ["http://192.168.1.10:3001", "https://example.com", "https://untrusted.example.com"],
      (origin) =>
        Effect.gen(function* () {
          const allowed = origin === "https://untrusted.example.com" ? null : origin
          const preflight = yield* Effect.promise(() =>
            fetch(new URL("/api/health", HttpServer.formatAddress(server.address)), {
              method: "OPTIONS",
              headers: {
                origin,
                "access-control-request-method": "GET",
                "access-control-request-headers": "content-type",
              },
            }),
          )
          expect(preflight.status).toBe(204)
          expect(preflight.headers.get("access-control-allow-origin")).toBe(allowed)

          const health = yield* Effect.promise(() =>
            fetch(new URL("/api/health", HttpServer.formatAddress(server.address)), {
              headers: { origin },
            }),
          )
          expect(health.status).toBe(200)
          expect(health.headers.get("access-control-allow-origin")).toBe(allowed)
          yield* Effect.promise(() => health.arrayBuffer())
        }),
    )

    const event = yield* Effect.promise(() =>
      fetch(new URL("/api/event", HttpServer.formatAddress(server.address)), {
        headers: { "accept-encoding": "br" },
      }),
    )
    expect(event.status).toBe(200)
    expect(event.headers.get("content-encoding")).toBeNull()
    yield* Effect.promise(() => event.body?.cancel() ?? Promise.resolve())

    const missing = yield* Effect.promise(() =>
      fetch(new URL("/missing", HttpServer.formatAddress(server.address)), {
        headers: { "accept-encoding": "br" },
      }),
    )
    expect(missing.status).toBe(200)
    expect(missing.headers.get("content-encoding")).toBe("br")
    expect(missing.headers.get("content-type")).toBe("text/plain")
    expect(missing.headers.get("vary")?.toLowerCase()).toContain("accept-encoding")
    expect(yield* Effect.promise(() => missing.text())).toBe(fallback)
  }),
)

function waitForMarkerRemoval(database: Database, key: string, remaining = 1_000): Effect.Effect<void, Error> {
  if (!database.query("select value from kv where key = ?").get(key)) return Effect.void
  if (remaining === 0) return Effect.fail(new Error("Timed out waiting for restart recovery"))
  return Effect.promise(() => Bun.sleep(1)).pipe(Effect.andThen(waitForMarkerRemoval(database, key, remaining - 1)))
}
