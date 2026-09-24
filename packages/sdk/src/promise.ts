export * as PromiseSdk from "./promise"

import { Ocpp, type OcppClient } from "@ocpp/client"
import type { Plugin } from "@ocpp/plugin"
import { Effect } from "effect"
import { EmbeddedHost } from "./internal/host"

export interface CreateOptions extends Omit<EmbeddedHost.CreateOptions, "workspaceProviders"> {
  readonly plugins?: ReadonlyArray<Plugin.Plugin>
}

export type Interface = Omit<OcppClient, "plugin"> & {
  readonly sessions: OcppClient["session"]
  readonly events: OcppClient["event"]
  readonly plugin: ((plugin: Plugin.Plugin) => Promise<void>) & OcppClient["plugin"]
  readonly close: () => Promise<void>
  readonly [Symbol.asyncDispose]: () => Promise<void>
}

export async function create(options: CreateOptions = {}, embed: EmbeddedHost.EmbedOptions = {}): Promise<Interface> {
  const { plugins, ...hostOptions } = options
  const host = await Effect.runPromise(EmbeddedHost.create(hostOptions, embed))
  const client = Ocpp.make({ baseUrl: "http://ocpp.local", fetch: host.fetch })
  const register = async (plugin: Plugin.Plugin) => {
    const { PluginPromise } = await import("@ocpp/core/plugin/promise")
    return host.runtime.runPromise(host.plugins.register(PluginPromise.fromPromise(plugin)))
  }
  for (const plugin of plugins ?? []) await register(plugin)

  return {
    ...client,
    sessions: client.session,
    events: client.event,
    plugin: Object.assign(register, client.plugin),
    close: host.close,
    [Symbol.asyncDispose]: host.close,
  }
}
