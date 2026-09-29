import { Database } from "@ocpp/core/database/database"
import { V1Migration } from "@ocpp/core/database/v1-migration"
import { App } from "@ocpp/core/app"
import { LayerNode } from "@ocpp/util/effect/layer-node"
import { httpClient } from "@ocpp/util/effect/app-node-platform"
import { AppNodeBuilder } from "@ocpp/core/effect/app-node-builder"
import { Bus } from "@ocpp/core/bus"
import { EventLogger } from "@ocpp/core/event-logger"
import { FileSystemSearch } from "@ocpp/core/filesystem/search"
import { Credential } from "@ocpp/core/credential"
import { Config } from "@ocpp/core/config"
import { PtyTicket } from "@ocpp/core/pty/ticket"
import { PersistentPty } from "@ocpp/core/persistent-pty"
import { Project } from "@ocpp/core/project"
import { Session } from "@ocpp/core/session"
import { SessionTransfer } from "@ocpp/core/session/transfer"
import { ShellSelect } from "@ocpp/core/shell/select"
import { Job } from "@ocpp/core/job"
import { Mcp } from "@ocpp/core/mcp/index"
import { Global } from "@ocpp/util/global"
import { InstructionDiscovery } from "@ocpp/core/instruction-discovery"
import { LocationServiceMap } from "@ocpp/core/location-service-map"
import { LocationActivity } from "@ocpp/core/location-activity"
import { ModelsDev } from "@ocpp/core/models-dev"
import { SessionRestart } from "@ocpp/core/session/execution/restart"
import { CodeModeCommand } from "@ocpp/core/codemode/command"
import { CodeModeEvent } from "@ocpp/core/codemode/event"
import { CodeModeScheduler } from "@ocpp/core/codemode/scheduler"
import { PluginRuntime } from "@ocpp/core/plugin/runtime"
import { SdkPlugins } from "@ocpp/core/plugin/sdk"
import { WellKnown } from "@ocpp/core/wellknown"
import { Workspace } from "@ocpp/core/workspace"
import { Worktree } from "@ocpp/core/worktree"
import { Watcher } from "@ocpp/core/filesystem/watcher"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Context, Effect, Layer, Option } from "effect"
import { Api } from "./api"
import { ServerAuth } from "./auth"
import { CorsConfig } from "./cors"
import { handlers } from "./handlers"
import { authorizationLayer } from "./middleware/authorization"
import { schemaErrorLayer } from "./middleware/schema-error"
import { PtyEnvironment } from "./pty-environment"
import { layer } from "./location"
import { formLocationLayer } from "./middleware/form-location"
import { sessionLocationLayer } from "./middleware/session-location"
import { ServerInfo } from "./server-info"
import type { ServerOptions } from "./options"

const applicationServiceNodes = [
  Global.node,
  Database.node,
  Bus.node,
  EventLogger.node,
  httpClient,
  Job.node,
  Project.node,
  Worktree.node,
  Session.node,
  SessionTransfer.node,
  PluginRuntime.providerNode,
  SdkPlugins.node,
  PtyTicket.node,
  PersistentPty.node,
  Credential.node,
  WellKnown.node,
  PtyEnvironment.node,
  LocationServiceMap.node,
  LocationActivity.node,
  SessionRestart.node,
  CodeModeCommand.node,
  CodeModeEvent.node,
  CodeModeScheduler.node,
  Workspace.node,
] as const
const applicationServices = LayerNode.group(applicationServiceNodes)

export function createRoutes(
  options: ServerOptions = {},
  serviceURLs: () => ReadonlyArray<string> = () => [],
  overrides: LayerNode.Replacements = [],
) {
  return makeRoutes(
    options.password
      ? ServerAuth.Config.configLayer({ password: Option.some(options.password) })
      : ServerAuth.Config.layer,
    options,
    serviceURLs,
    overrides,
  )
}

export function createEmbeddedRoutes(options: ServerOptions = {}, overrides: LayerNode.Replacements = []) {
  return makeRoutes(ServerAuth.Config.configLayer({ password: Option.none() }), options, () => [], overrides)
}

function makeRoutes<AuthError, AuthServices>(
  auth: Layer.Layer<ServerAuth.Config, AuthError, AuthServices>,
  options: ServerOptions,
  serviceURLs: () => ReadonlyArray<string>,
  // Runtime-profile replacements (e.g. workerd) applied after the standard set, so later entries win.
  overrides: LayerNode.Replacements,
) {
  const pluginRuntimeCell = PluginRuntime.makeCell()
  const standard: LayerNode.Replacements = [
    [Database.node, Database.configured(options.database)],
    [PersistentPty.node, PersistentPty.configured(options.pty)],
    [Bus.node, Bus.configured({ persist: options.events?.persist })],
    [App.node, App.configured(options.app)],
    [ModelsDev.node, ModelsDev.configured(options.models)],
    [Watcher.node, Watcher.configured({ enabled: options.fs?.filewatcher })],
    [FileSystemSearch.node, FileSystemSearch.configured({ fff: options.fs?.fff })],
    [Global.node, Global.layerWith(options.config?.directory ? { config: options.config.directory } : {})],
    [
      Config.node,
      Config.configured({
        project: options.config?.project,
        file: options.config?.file,
        content: options.config?.content,
      }),
    ],
    [InstructionDiscovery.node, InstructionDiscovery.configured({ project: options.config?.project })],
    [ShellSelect.node, ShellSelect.configured({ gitbash: options.windows?.gitbash })],
    [
      Mcp.node,
      Mcp.configured({
        clientInfo: {
          name: options.app?.name ?? "ocpp",
          version: options.app?.version ?? "unknown",
        },
      }),
    ],
    [PluginRuntime.node, PluginRuntime.layerWithCell(pluginRuntimeCell)],
    [PluginRuntime.providerNode, PluginRuntime.providerNodeWithCell(pluginRuntimeCell)],
  ]
  const replacements: LayerNode.Replacements = [...standard, ...overrides]
  const serviceLayer = options.simulation
    ? Layer.unwrap(
        Effect.gen(function* () {
          const { simulationReplacements } = yield* Effect.promise(() => import("@ocpp/simulation/backend"))
          const simulation = yield* simulationReplacements({ version: App.make(options.app).version })
          return AppNodeBuilder.build(applicationServices, [...replacements, ...simulation])
        }),
      )
    : AppNodeBuilder.build(applicationServices, replacements)
  return serviceLayer.pipe(
    Layer.flatMap((context) => {
      const services = Layer.succeedContext(context)
      const requestServices = Layer.merge(
        Layer.succeedContext(Context.pick(Database.Service, Project.Service, WellKnown.Service)(context)),
        ServerInfo.layer(serviceURLs, options.app),
      )
      const api = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
        Layer.provide(handlers.pipe(Layer.provide(services), Layer.provide(Layer.succeed(CorsConfig, options)))),
        Layer.provide(formLocationLayer),
        Layer.provide(sessionLocationLayer),
        Layer.provide(layer),
        Layer.provide(authorizationLayer),
        Layer.provide(schemaErrorLayer),
        Layer.provide(auth),
        HttpRouter.provideRequest(requestServices),
        Layer.provideMerge(services),
        Layer.provideMerge(HttpRouter.layer),
      )
      return Layer.merge(api, V1Migration.layer.pipe(Layer.provide(services)))
    }),
  )
}
