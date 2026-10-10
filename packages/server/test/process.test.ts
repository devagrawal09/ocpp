import { expect } from "bun:test"
import path from "node:path"
import { Bus } from "@ocpp/core/bus"
import { Database } from "@ocpp/core/database/database"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { Job } from "@ocpp/core/job"
import { JobBackgroundTable } from "@ocpp/core/job/sql"
import { SessionMessage } from "@ocpp/core/session/message"
import { SessionSchema } from "@ocpp/core/session/schema"
import { SessionFact } from "@ocpp/schema/session-fact"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { HttpServer, HttpServerError, HttpServerResponse } from "effect/http"
import { it } from "../../core/test/lib/effect"
import { Recorded } from "../../core/test/lib/recorded"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { ServerProcess } from "../src/process"

it.live("recovers durable background work for a foreground server", () =>
  Effect.gen(function* () {
    const directory = yield* tmpdirScoped("ocpp-server-process-")
    const filename = path.join(directory.path, "process.db")
    const database = [Database.node, Database.configured({ path: filename })] as const
    const notificationID = SessionMessage.ID.make("msg_process_restart")

    // The process before the restart backgrounded a Code Mode run whose parent Session is gone, and stopped
    // with the run still going. What it leaves behind is the marker its recorded fact projects.
    yield* Job.Service.use((jobs) =>
      jobs
        .start({
          id: "exe_process_restart",
          type: "codemode",
          notificationID,
          recovery: {
            kind: "codemode",
            parentSessionID: SessionSchema.ID.make("ses_process_restart_missing"),
            assistantMessageID: SessionMessage.ID.make("msg_process_restart_assistant"),
            toolCallID: "call_process_restart",
          },
          run: Effect.never,
        })
        .pipe(Effect.andThen((job) => jobs.background(job.id))),
    ).pipe(Effect.provide(AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, Job.node]), [database])))

    yield* Effect.gen(function* () {
      expect(yield* marker(notificationID)).toMatchObject({ job_id: "exe_process_restart", status: "running" })

      yield* ServerProcess.start<never, never>({ hostname: "127.0.0.1", port: 0, database: { path: filename } })
      yield* waitForMarkerRemoval(notificationID)
      // Recovery removed the marker by recording that nothing is left to deliver.
      expect(yield* Recorded.types(notificationID)).toEqual([
        SessionFact.BackgroundStarted.type,
        SessionFact.BackgroundCompleted.type,
      ])
    }).pipe(Effect.provide(AppNodeBuilder.build(Database.node, [database])))
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

function marker(notificationID: SessionMessage.ID) {
  return Database.Service.use((database) =>
    database.db
      .select()
      .from(JobBackgroundTable)
      .where(eq(JobBackgroundTable.notification_id, notificationID))
      .get()
      .pipe(Effect.orDie),
  )
}

// Recovery runs in the background once the server is up, so the marker goes some time after `start` returns.
function waitForMarkerRemoval(
  notificationID: SessionMessage.ID,
  remaining = 1_000,
): Effect.Effect<void, Error, Database.Service> {
  return Effect.gen(function* () {
    if (!(yield* marker(notificationID))) return
    if (remaining === 0) return yield* Effect.fail(new Error("Timed out waiting for restart recovery"))
    yield* Effect.sleep("2 millis")
    yield* waitForMarkerRemoval(notificationID, remaining - 1)
  })
}
