export * as ExternalAgentDrivers from "./drivers.js"

import { available, driver, models } from "#external-agents"
import { ExternalSession } from "@ocpp/schema/external-session"
import { SessionDriver } from "@ocpp/schema/session-driver"
import { makeLocationNode } from "@ocpp/util/effect/app-node"
import { Clock, Context, Duration, Effect, Layer } from "effect"
import { Config } from "../config.js"
import { ExternalAgentDriver } from "./driver.js"
import { ExternalAgentEffort } from "./effort.js"
import { ExternalAgentModels } from "./models.js"

/** The runtime that probes vendor readiness and loads SDK drivers. The workerd adapter offers none. */
export interface Platform {
  readonly available: (provider: ExternalSession.Provider) => Promise<boolean>
  readonly driver: (provider: ExternalSession.Provider) => Promise<ExternalAgentDriver.Driver>
  /** The vendor's own model catalog. Absent, the vendor lists none. */
  readonly models?: (provider: ExternalSession.Provider) => Promise<ReadonlyArray<ExternalAgentModels.Model>>
}

/** Each vendor's model when `external_agents` names none. */
export const defaults = { claude: "sonnet", codex: "sol", pi: "anthropic/claude-sonnet-4-6" }
/** Models offered besides each vendor's own catalog. Claude Code's aliases always run its newest models. */
const suggested = {
  claude: ["opus", "sonnet", "haiku", "fable"],
  codex: [],
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
  /** The vendor's own model catalog, read again at each call, or empty when it lists none. */
  readonly models: (provider: ExternalSession.Provider) => Effect.Effect<ReadonlyArray<ExternalAgentModels.Model>>
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
      // Probes run the vendor CLI. Only the first is awaited; signing in takes effect within about five minutes.
      const probes = {
        claude: yield* refreshed(probe(platform, "claude"), "5 minutes"),
        codex: yield* refreshed(probe(platform, "codex"), "5 minutes"),
        pi: yield* refreshed(probe(platform, "pi"), "5 minutes"),
      }
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
      const models = Effect.fn("ExternalAgentDrivers.models")(function* (provider: ExternalSession.Provider) {
        const listing = platform.models
        if (listing === undefined) return []
        return yield* Effect.promise(() => listing(provider).catch(() => []))
      })
      const list = Effect.fn("ExternalAgentDrivers.list")(function* () {
        return yield* Effect.forEach(
          ExternalSession.Provider.literals,
          (provider) =>
            Effect.gen(function* () {
              const model = (yield* settings(provider)).model
              const listed = yield* models(provider)
              const aliases = ExternalAgentModels.aliases(listed)
              // Aliases stand for their newest models; older and superseded models still run when named.
              const current = listed.filter(
                (item) =>
                  item.listed &&
                  !Object.values(aliases).includes(item.id) &&
                  ExternalAgentModels.newer(item.id, listed) === undefined,
              )
              return {
                id: provider,
                name: SessionDriver.names[provider],
                available: (yield* unavailable(provider)) === undefined,
                model,
                models: [
                  ...new Set([
                    model,
                    ...suggested[provider],
                    ...Object.keys(aliases),
                    ...current.map((item) => item.id),
                  ]),
                ],
                ...(Object.keys(aliases).length === 0 ? {} : { aliases }),
                variants: [...ExternalAgentEffort[provider].literals],
              }
            }),
          { concurrency: "unbounded" },
        )
      })
      // Warm the enabled vendors' probes so the first catalog or subagent call does not wait on a vendor CLI.
      yield* list().pipe(Effect.forkScoped)
      return Service.of({
        list,
        models,
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

/**
 * A check that is awaited once and then served from its last answer. An answer older than `ttl` is still served while
 * one background check replaces it, so no caller waits on the check again.
 */
export const refreshed = Effect.fnUntraced(function* <E>(check: Effect.Effect<boolean, E>, ttl: Duration.Input) {
  const scope = yield* Effect.scope
  const state = { value: undefined as boolean | undefined, at: 0, refreshing: false }
  const record = (value: boolean) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        state.value = value
        state.at = now
        return value
      }),
    )
  const first = yield* Effect.cached(check.pipe(Effect.flatMap(record)))
  const refresh = check.pipe(
    Effect.flatMap(record),
    Effect.ignore,
    Effect.ensuring(
      Effect.sync(() => {
        state.refreshing = false
      }),
    ),
  )
  return Effect.gen(function* () {
    if (state.value === undefined) return yield* first
    if (!state.refreshing && (yield* Clock.currentTimeMillis) - state.at >= Duration.toMillis(ttl)) {
      state.refreshing = true
      yield* Effect.forkIn(refresh, scope)
    }
    return state.value
  })
})

function probe(platform: Platform, provider: ExternalSession.Provider) {
  return Effect.promise(() => platform.available(provider).catch(() => false))
}

export const node = makeLocationNode({
  service: Service,
  layer: layer({ available, driver, models }),
  deps: [Config.node],
})
