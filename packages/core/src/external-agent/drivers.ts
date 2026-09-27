export * as ExternalAgentDrivers from "./drivers.js"

import { available, driver } from "#external-agents"
import { ExternalSession } from "@ocpp/schema/external-session"
import { SessionDriver } from "@ocpp/schema/session-driver"
import { makeLocationNode } from "@ocpp/util/effect/app-node"
import { Context, Effect, Layer } from "effect"
import { Config } from "../config.js"
import { ExternalAgentDriver } from "./driver.js"
import { ExternalAgentEffort } from "./effort.js"

/** The runtime that probes vendor readiness and loads SDK drivers. The workerd adapter offers none. */
export interface Platform {
  readonly available: (provider: ExternalSession.Provider) => Promise<boolean>
  readonly driver: (provider: ExternalSession.Provider) => Promise<ExternalAgentDriver.Driver>
}

const defaults = { claude: "sonnet", codex: "gpt-5.6-sol", pi: "anthropic/claude-sonnet-4-6" }
const suggested = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
  pi: [],
}
const setup = {
  claude: "install the `claude` CLI and sign in with `claude login`",
  codex: "install the `codex` CLI and sign in with `codex login`",
  pi: "configure authentication for a Pi model provider",
}

export interface Interface {
  /** Every vendor driver and whether it is ready: enabled in `external_agents`, installed, and signed in. */
  readonly list: () => Effect.Effect<ReadonlyArray<SessionDriver.Info>>
  /** The configured model and effort for a vendor. */
  readonly settings: (
    provider: ExternalSession.Provider,
  ) => Effect.Effect<{ readonly model: string; readonly effort?: string }>
  /** Why a vendor cannot drive a Session here, or undefined when it can. */
  readonly unavailable: (provider: ExternalSession.Provider) => Effect.Effect<string | undefined>
  /** A ready vendor's SDK driver, or a failure that says how to make it ready. */
  readonly driver: (
    provider: ExternalSession.Provider,
  ) => Effect.Effect<ExternalAgentDriver.Driver, ExternalAgentDriver.Error>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/ExternalAgentDrivers") {}

export const layer = (platform: Platform) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      // Probes run the vendor CLI, so a result is reused for a while; signing in takes effect within five minutes.
      const probes = {
        claude: yield* Effect.cachedWithTTL(probe(platform, "claude"), "5 minutes"),
        codex: yield* Effect.cachedWithTTL(probe(platform, "codex"), "5 minutes"),
        pi: yield* Effect.cachedWithTTL(probe(platform, "pi"), "5 minutes"),
      }
      // Warm the probes so the first catalog or subagent call does not wait on a vendor CLI.
      yield* Effect.all(Object.values(probes), { concurrency: "unbounded" }).pipe(Effect.forkScoped)
      const configured = Effect.fnUntraced(function* (provider: ExternalSession.Provider) {
        return Config.latest(yield* config.entries(), "external_agents")?.[provider]
      })
      const unavailable = Effect.fn("ExternalAgentDrivers.unavailable")(function* (provider: ExternalSession.Provider) {
        if ((yield* configured(provider))?.enabled === false)
          return `${SessionDriver.names[provider]} is disabled by external_agents.${provider}.enabled.`
        if (yield* probes[provider]) return undefined
        return `${SessionDriver.names[provider]} is not available on this machine: ${setup[provider]}.`
      })
      const settings = Effect.fn("ExternalAgentDrivers.settings")(function* (provider: ExternalSession.Provider) {
        const selected = yield* configured(provider)
        return {
          model: selected?.model ?? defaults[provider],
          ...(selected?.effort === undefined ? {} : { effort: selected.effort }),
        }
      })
      return Service.of({
        list: Effect.fn("ExternalAgentDrivers.list")(function* () {
          return yield* Effect.forEach(
            ExternalSession.Provider.literals,
            (provider) =>
              Effect.gen(function* () {
                const model = (yield* settings(provider)).model
                return {
                  id: provider,
                  name: SessionDriver.names[provider],
                  available: (yield* unavailable(provider)) === undefined,
                  model,
                  models: [...new Set([model, ...suggested[provider]])],
                  variants: [...ExternalAgentEffort[provider].literals],
                }
              }),
            { concurrency: "unbounded" },
          )
        }),
        settings,
        unavailable,
        driver: Effect.fn("ExternalAgentDrivers.driver")(function* (provider: ExternalSession.Provider) {
          const reason = yield* unavailable(provider)
          if (reason !== undefined) return yield* new ExternalAgentDriver.Error({ message: reason })
          return yield* Effect.tryPromise({
            try: () => platform.driver(provider),
            catch: (error) => new ExternalAgentDriver.Error({ message: String(error) }),
          })
        }),
      })
    }),
  )

function probe(platform: Platform, provider: ExternalSession.Provider) {
  return Effect.promise(() => platform.available(provider).catch(() => false))
}

export const node = makeLocationNode({ service: Service, layer: layer({ available, driver }), deps: [Config.node] })
