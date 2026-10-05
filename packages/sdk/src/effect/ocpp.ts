export * as Ocpp from "./ocpp"

import { Ocpp, type OcppClient } from "@ocpp/client/effect"
import type { Workspace } from "@ocpp/core/workspace"
import { Context, Effect, Layer } from "effect"
import type { Config, Scope } from "effect"
import { FetchHttpClient } from "effect/http"
import { EmbeddedHost } from "../internal/host"

export type { LogEntry, LogLevel, LogOptions, LogWriter } from "../logging"

export type CreateOptions = EmbeddedHost.CreateOptions
export type EmbedOptions = EmbeddedHost.EmbedOptions

export type Interface = Omit<OcppClient, "plugin" | "workspace"> & {
  readonly sessions: OcppClient["session"]
  readonly events: OcppClient["event"]
  readonly workspace: {
    readonly create: Workspace.Interface["create"]
    readonly provision: (options: {
      readonly workspaceID: Workspace.ID
    }) => ReturnType<Workspace.Interface["provision"]>
    readonly destroy: (options: { readonly workspaceID: Workspace.ID }) => ReturnType<Workspace.Interface["destroy"]>
  }
  readonly plugin: EmbeddedHost.Interface["plugins"]["register"] & OcppClient["plugin"]
}

export const create: (
  options?: CreateOptions,
  embed?: EmbedOptions,
) => Effect.Effect<Interface, Config.ConfigError | Error, Scope.Scope> = Effect.fn("Ocpp.create")(function* (
  options: CreateOptions = {},
  embed: EmbedOptions = {},
) {
  const host = yield* Effect.acquireRelease(EmbeddedHost.create(options, embed), (host) => Effect.promise(host.close))
  const client = yield* Ocpp.make({ baseUrl: "http://ocpp.local" }).pipe(
    Effect.provide(
      FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, host.fetch)), Layer.fresh),
    ),
  )

  return {
    ...client,
    sessions: client.session,
    events: client.event,
    workspace: {
      create: host.workspace.create,
      provision: ({ workspaceID }: { readonly workspaceID: Workspace.ID }) => host.workspace.provision(workspaceID),
      destroy: ({ workspaceID }: { readonly workspaceID: Workspace.ID }) => host.workspace.destroy(workspaceID),
    },
    plugin: Object.assign(host.plugins.register, client.plugin),
  }
})

export class Service extends Context.Service<Service, Interface>()("@ocpp/sdk/Ocpp") {}

export const layer = (options: CreateOptions = {}): Layer.Layer<Service, Config.ConfigError | Error> =>
  Layer.effect(Service, create(options))
