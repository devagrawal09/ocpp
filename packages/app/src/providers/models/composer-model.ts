import { SessionDriver } from "@ocpp/schema/session-driver"
import { referencedModel } from "@/runtime/server/global-sync/utils"
import type { Provider } from "@/runtime/server/types"

type ModelKey = { providerID: string; modelID: string }

/**
 * The model a composer sends with. An existing Session keeps its own model, its unsent pick or else the model it
 * stores, even when the picker does not offer it, so a prompt never moves the Session to another model. A draft, or a
 * Session without a model, starts on the first available of its own pick, its agent's model, the most recent pick,
 * the config `model` and the first connected model.
 */
export function composerModel(input: {
  session?: ModelKey
  pick?: ModelKey
  agent?: ModelKey
  recent: ReadonlyArray<ModelKey>
  configured?: ModelKey
  first?: ModelKey
  available: (model: ModelKey) => boolean
}) {
  if (input.session) return input.session
  return [input.pick, input.agent, ...input.recent, input.configured, input.first].find(
    (item): item is ModelKey => !!item && input.available(item),
  )
}

/**
 * Describes a Session's own model that the picker does not list: a driver model outside the driver's suggestions, a
 * driver that is not ready, or any driver model before the driver list arrives. `provider` is the catalog entry, if
 * any, and `variant` the one the Session uses, kept so that sending does not reset it.
 */
export function describeModel(key: ModelKey & { variant?: string | null }, provider: Provider | undefined) {
  const known = provider?.models[key.modelID]
  const driver = SessionDriver.of(key)
  const owner = provider?.name ?? (driver === "ocpp" ? undefined : SessionDriver.names[driver])
  // A driver's efforts apply to every model it runs; another provider's variants belong to each model.
  const siblings = driver === "ocpp" ? [] : Object.keys(Object.values(provider?.models ?? {})[0]?.variants ?? {})
  const variants = [...new Set([...siblings, ...(key.variant && key.variant !== "default" ? [key.variant] : [])])]
  return {
    ...(known ?? referencedModel(key.providerID, key.modelID, variants)),
    // The model ID leads, so the composer's narrow model button truncates the provider rather than the model.
    name: known?.name ?? (owner ? `${key.modelID} (${owner})` : `${key.providerID}/${key.modelID}`),
    latest: false,
    provider: provider ?? {
      id: key.providerID,
      name: owner ?? key.providerID,
      source: "custom" as const,
      env: [],
      options: {},
      models: {},
    },
  }
}
