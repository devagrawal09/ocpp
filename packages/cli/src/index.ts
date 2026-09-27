#!/usr/bin/env bun

import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { Commands } from "./commands/commands"
import { Runtime } from "./framework/runtime"
import { Observability } from "@ocpp/util/observability"
import { Updater } from "./services/updater"
import { OCPP_CHANNEL, OCPP_LOCAL, OCPP_VERSION } from "./version"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { Global } from "@ocpp/util/global"
import { AppProcess } from "@ocpp/util/process"
import { Npm } from "@ocpp/util/npm"
import { Heap } from "./heap"
import { CpuProfile } from "./cpu-profile"

const Handlers = Runtime.handlers(Commands, {
  $: () => import("./commands/handlers/default"),
  upgrade: () => import("./commands/handlers/upgrade"),
  acp: () => import("./commands/handlers/acp"),
  api: () => import("./commands/handlers/api"),
  auth: {
    list: () => import("./commands/handlers/auth/list"),
    login: () => import("./commands/handlers/auth/login"),
    logout: () => import("./commands/handlers/auth/logout"),
  },
  debug: {
    agents: () => import("./commands/handlers/debug/agents"),
    config: () => import("./commands/handlers/debug/config"),
    paths: () => import("./commands/handlers/debug/paths"),
  },
  console: {
    login: () => import("./commands/handlers/console/login"),
  },
  mcp: {
    list: () => import("./commands/handlers/mcp/list"),
    add: () => import("./commands/handlers/mcp/add"),
    auth: () => import("./commands/handlers/mcp/auth"),
    logout: () => import("./commands/handlers/mcp/logout"),
  },
  plugin: {
    list: () => import("./commands/handlers/plugin/list"),
    add: () => import("./commands/handlers/plugin/add"),
    remove: () => import("./commands/handlers/plugin/remove"),
  },
  models: () => import("./commands/handlers/models"),
  stats: () => import("./commands/handlers/stats"),
  export: () => import("./commands/handlers/export"),
  import: () => import("./commands/handlers/import"),
  run: () => import("./commands/handlers/run"),
  pair: () => import("./commands/handlers/pair"),
  service: {
    start: () => import("./commands/handlers/service/start"),
    restart: () => import("./commands/handlers/service/restart"),
    status: () => import("./commands/handlers/service/status"),
    stop: () => import("./commands/handlers/service/stop"),
    get: () => import("./commands/handlers/service/get"),
    set: () => import("./commands/handlers/service/set"),
    unset: () => import("./commands/handlers/service/unset"),
  },
  serve: () => import("./commands/handlers/serve"),
})

Effect.gen(function* () {
  yield* Heap.listen
  yield* CpuProfile.listen
  const runFork = Effect.runForkWith(yield* Effect.context<never>())
  const uncaughtException = (cause: Error, origin: "uncaughtException" | "unhandledRejection") => {
    runFork(Effect.logError("uncaught exception", { cause, origin }))
  }
  const unhandledRejection = (cause: unknown) => {
    runFork(Effect.logError("unhandled rejection", { cause }))
  }
  process.on("uncaughtException", uncaughtException)
  process.on("unhandledRejection", unhandledRejection)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      process.off("uncaughtException", uncaughtException)
      process.off("unhandledRejection", unhandledRejection)
    }),
  )
  yield* Effect.logInfo("cli starting", {
    version: OCPP_VERSION,
    channel: OCPP_CHANNEL,
    local: OCPP_LOCAL,
    args: process.argv.slice(2),
  })
  return yield* Runtime.run(Commands, Handlers, { version: OCPP_VERSION })
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logError("cli process failed", {
      cause,
      args: process.argv.slice(2),
    }).pipe(Effect.andThen(Effect.failCause(cause))),
  ),
  Effect.annotateLogs({ role: "cli" }),
  Effect.provide(Updater.layer),
  Effect.provide(
    LayerNode.compile(LayerNode.group([Global.node, AppProcess.node, Npm.node]), [
      [Global.node, Global.layerWith(process.env.OCPP_CONFIG_DIR ? { config: process.env.OCPP_CONFIG_DIR } : {})],
    ]),
  ),
  Effect.provide(
    Observability.layer({
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      headers: process.env.OTEL_EXPORTER_OTLP_HEADERS,
      client: process.env.OCPP_CLIENT ?? "cli",
      version: OCPP_VERSION,
      channel: OCPP_CHANNEL,
    }),
  ),
  Effect.provide(NodeServices.layer),
  Effect.scoped,
  Effect.tap(() => Effect.sync(() => process.exit(process.exitCode ?? 0))),
  NodeRuntime.runMain,
)
