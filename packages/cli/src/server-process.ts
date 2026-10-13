export * as ServerProcess from "./server-process"

import { NodeServices } from "@effect/platform-node"
import { Service, type DiscoverOptions } from "@ocpp/client/effect/service"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Global } from "@ocpp/util/global"
import { OCPP_CHANNEL, OCPP_VERSION } from "./version"
import { AppProcess } from "@ocpp/util/process"
import { randomUUID } from "node:crypto"
import { Effect, Option, Schedule, Schema } from "effect"
import { PersistentPty } from "@ocpp/schema/persistent-pty"
import { HttpServer } from "effect/http"
import { ServiceConfig } from "./services/service-config"
import { ServiceRegistration } from "./services/service-registration"
import { Updater } from "./services/updater"
import { WebUi } from "./services/web-ui"

export type Mode = "default" | "service" | "stdio"

export type Options = {
  readonly mode: Mode
  readonly hostname?: string
  readonly port?: number
  readonly cors?: readonly string[]
}

// The process effect lives until server shutdown; tracing it would parent every request to one process-lifetime trace.
export const run = Effect.fnUntraced(function* (options: Options) {
  return yield* processEffect(options).pipe(
    Effect.provide(Updater.layer),
    Effect.provide(
      LayerNode.compile(LayerNode.group([Global.node, AppProcess.node]), [
        [Global.node, Global.layerWith(process.env.OCPP_CONFIG_DIR ? { config: process.env.OCPP_CONFIG_DIR } : {})],
      ]),
    ),
    Effect.provide(NodeServices.layer),
  )
})

const processEffect = Effect.fnUntraced(function* (options: Options) {
  const inherited = process.env.OCPP_PTY_HANDOFF
  delete process.env.OCPP_PTY_HANDOFF
  const handoff =
    inherited === undefined
      ? undefined
      : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PersistentPty.Handoff))(inherited).pipe(
          Effect.mapError(() => new Error("Invalid PTY restart handoff")),
        )
  const global = yield* Global.Service
  if (options.mode === "service") yield* Effect.sync(() => process.chdir(global.home))
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const serviceOptions = options.mode === "service" ? yield* ServiceConfig.options() : undefined
      const config = options.mode === "service" ? yield* ServiceConfig.read() : {}
      const hostname = options.hostname ?? config.hostname ?? "127.0.0.1"
      const port = options.port ?? config.port ?? (options.mode === "service" ? ServiceConfig.defaultPort() : undefined)
      const incumbent =
        serviceOptions !== undefined && port !== undefined
          ? yield* Service.incumbent({ ...serviceOptions, url: serviceURL(hostname, port) })
          : undefined
      if (incumbent !== undefined) return
      const { start } = yield* Effect.promise(() => import("@ocpp/server/process"))
      const instanceID = randomUUID()
      const transform = yield* WebUi.handler()
      const server = yield* start(
        {
          app: {
            name: process.env.OCPP_CLIENT ?? "cli",
            version: OCPP_VERSION,
            channel: OCPP_CHANNEL,
          },
          hostname,
          port,
          cors: options.cors ?? config.cors,
          pty: { handoff },
          simulation: truthy(process.env.OCPP_SIMULATE),
          database: {
            path:
              process.env.OCPP_DB ??
              (["latest", "dev", "beta", "next", "prod"].includes(OCPP_CHANNEL) ||
              process.env.OCPP_DISABLE_CHANNEL_DB === "1" ||
              process.env.OCPP_DISABLE_CHANNEL_DB === "true"
                ? "ocpp.db"
                : `ocpp-${OCPP_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`),
          },
          models: {
            url: process.env.OCPP_MODELS_URL,
            file: process.env.OCPP_MODELS_PATH,
            fetch: !truthy(process.env.OCPP_DISABLE_MODELS_FETCH),
          },
          config: {
            directory: process.env.OCPP_CONFIG_DIR,
            project: !truthy(process.env.OCPP_CONFIG_PROJECT_DISABLE ?? process.env.OCPP_DISABLE_PROJECT_CONFIG),
            file: process.env.OCPP_CONFIG,
            content: process.env.OCPP_CONFIG_CONTENT,
          },
          windows: {
            gitbash: process.env.OCPP_GIT_BASH_PATH,
          },
          fs: {
            filewatcher: !truthy(process.env.OCPP_FILEWATCHER_DISABLE ?? process.env.OCPP_DISABLE_FILEWATCHER),
            fff:
              process.env.OCPP_DISABLE_FFF === undefined
                ? process.platform !== "win32"
                : !truthy(process.env.OCPP_DISABLE_FFF),
          },
        },
        serviceOptions === undefined
          ? undefined
          : {
              onListen: (address, shutdown) =>
                ServiceRegistration.register({
                  address,
                  id: instanceID,
                  file: serviceOptions.file,
                  shutdown,
                }),
            },
        transform,
      ).pipe(
        Effect.catch((error) => {
          if (serviceOptions === undefined || port === undefined || !addressInUse(error)) return Effect.fail(error)
          return recognizeIncumbent(serviceOptions, hostname, port).pipe(
            Effect.flatMap((found) =>
              found
                ? Effect.void
                : Effect.fail(
                    new Error(
                      `Managed service port ${port} on ${hostname} is already in use by another process. ` +
                        "Configure another port with `ocpp service set port <port>` and start the service again.",
                      { cause: error },
                    ),
                  ),
            ),
          )
        }),
      )
      if (server === undefined) return
      const url = HttpServer.formatAddress(server.address)
      console.log(options.mode === "stdio" ? JSON.stringify({ url }) : `server listening on ${url}`)
      const updater = yield* Updater.Service
      yield* updater.check().pipe(Effect.schedule(Schedule.spaced("10 minutes")), Effect.forkScoped)
      return yield* options.mode === "service"
        ? server.shutdown
        : options.mode === "stdio"
          ? waitForStdinClose()
          : Effect.never
    }).pipe(Effect.annotateLogs({ role: "server" })),
  )
})

const recognizeIncumbent = Effect.fnUntraced(function* (options: DiscoverOptions, hostname: string, port: number) {
  const found = yield* Service.incumbent({ ...options, url: serviceURL(hostname, port) }).pipe(
    Effect.filterOrFail((value) => value !== undefined),
    Effect.retry(Schedule.spaced("100 millis")),
    Effect.timeoutOption("15 seconds"),
  )
  return Option.isSome(found)
})

function serviceURL(hostname: string, port: number) {
  return `http://${hostname.includes(":") ? `[${hostname}]` : hostname}:${port}`
}

function truthy(value?: string) {
  return value === "1" || value?.toLowerCase() === "true"
}

function addressInUse(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  if ("code" in error && error.code === "EADDRINUSE") return true
  return "cause" in error && addressInUse(error.cause)
}

function waitForStdinClose() {
  return Effect.callback<void>((resume) => {
    const close = () => resume(Effect.void)
    process.stdin.once("end", close)
    process.stdin.once("close", close)
    process.stdin.resume()
    if (process.stdin.readableEnded || process.stdin.destroyed) close()
    return Effect.sync(() => {
      process.stdin.off("end", close)
      process.stdin.off("close", close)
      process.stdin.pause()
    })
  })
}
