import type {
  AgentListOutput,
  ConfigEntry,
  ModelListOutput,
  ProviderListOutput,
  SessionDriverInfo,
} from "@ocpp/client/promise"
import type { Agent, Project, Provider, ProviderListResponse } from "@/runtime/server/types"
import type { Project as CurrentProject } from "@ocpp/client/promise"
import { unwrap } from "solid-js/store"
export { pathKey as directoryKey, type PathKey as DirectoryKey } from "@/workspaces/path-key"

export const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const providerCatalogs = new WeakMap<
  ProviderListOutput["data"],
  WeakMap<ModelListOutput["data"], ProviderListResponse>
>()

export function normalizeAgentList(input: AgentListOutput["data"] | Agent[]): Agent[] {
  if (input.every((agent) => !("request" in agent))) return input as Agent[]
  return (input as AgentListOutput["data"]).map((agent) => ({
    name: agent.id,
    description: agent.description,
    mode: agent.mode,
    hidden: agent.hidden,
    temperature:
      typeof agent.request.settings.temperature === "number" ? agent.request.settings.temperature : undefined,
    topP: typeof agent.request.settings.topP === "number" ? agent.request.settings.topP : undefined,
    color: agent.color,
    model: agent.model && { providerID: agent.model.providerID, modelID: agent.model.id },
    variant: agent.model?.variant,
    prompt: agent.system,
    options: agent.request.settings,
    steps: agent.steps,
  }))
}

export function normalizeProviderList(
  input: ProviderListOutput["data"] | ProviderListResponse,
  catalog?: ModelListOutput["data"],
): ProviderListResponse {
  if (!Array.isArray(input)) return input
  // Client sync replaces whole catalog lists. Track those reads at the caller,
  // not every model field, and share conversions without retaining old lists.
  const providers = unwrap(input)
  const models = unwrap(catalog)
  const cached = models && providerCatalogs.get(providers)?.get(models)
  if (cached) return cached
  const all = new Map<string, Provider>()

  for (const provider of providers) {
    all.set(provider.id, {
      id: provider.id,
      name: provider.name,
      source: "custom",
      env: [],
      options: provider.settings ?? {},
      models: {},
    })
  }

  for (const model of models ?? []) {
    const provider = all.get(model.providerID)
    if (!provider || model.status === "deprecated") continue
    const cost = model.cost.find((item) => item.tier === undefined) ?? model.cost[0]
    provider.models[model.id] = {
      id: model.id,
      providerID: model.providerID,
      api: {
        id: model.modelID,
        url: "",
        npm: model.package ?? provider.id,
      },
      name: model.name,
      family: model.family,
      capabilities: {
        temperature: false,
        reasoning: false,
        attachment: model.capabilities.input.some((item) => item !== "text"),
        toolcall: model.capabilities.tools,
        input: {
          text: model.capabilities.input.includes("text"),
          audio: model.capabilities.input.includes("audio"),
          image: model.capabilities.input.includes("image"),
          video: model.capabilities.input.includes("video"),
          pdf: model.capabilities.input.includes("pdf"),
        },
        output: {
          text: model.capabilities.output.includes("text"),
          audio: model.capabilities.output.includes("audio"),
          image: model.capabilities.output.includes("image"),
          video: model.capabilities.output.includes("video"),
          pdf: model.capabilities.output.includes("pdf"),
        },
        interleaved: false,
      },
      cost: {
        input: cost?.input ?? 0,
        output: cost?.output ?? 0,
        cache: {
          read: cost?.cache.read ?? 0,
          write: cost?.cache.write ?? 0,
        },
      },
      limit: model.limit,
      status: model.status,
      options: model.settings ?? {},
      headers: model.headers ?? {},
      release_date: new Date(model.time.released).toISOString().slice(0, 10),
      variants: Object.fromEntries(model.variants.map((variant) => [variant.id, variant.settings ?? {}])),
    }
  }

  const result = {
    all,
    connected: providers.map((provider) => provider.id),
    default: Object.fromEntries(
      providers.flatMap((provider) => {
        const model = models?.find((item) => item.providerID === provider.id && item.status !== "deprecated")
        return model ? [[provider.id, model.id]] : []
      }),
    ),
  }
  if (models) {
    const cache = providerCatalogs.get(providers) ?? new WeakMap<ModelListOutput["data"], ProviderListResponse>()
    cache.set(models, result)
    providerCatalogs.set(providers, cache)
  }
  return result
}

/**
 * Adds vendor drivers (Claude Code, Codex, Pi) to the picker as providers whose models select that driver: a
 * session whose model is claude/opus is driven by Claude Code. Only ready drivers count as connected.
 */
export function withDrivers(catalog: ProviderListResponse, drivers: ReadonlyArray<SessionDriverInfo>) {
  if (drivers.length === 0) return catalog
  return {
    all: new Map([
      ...catalog.all,
      ...drivers.map((driver): [string, Provider] => [
        driver.id,
        {
          id: driver.id,
          name: driver.name,
          source: "custom",
          env: [],
          options: {},
          models: Object.fromEntries(
            driver.models.map((id) => [
              id,
              {
                id,
                providerID: driver.id,
                api: { id, url: "", npm: driver.id },
                name: id,
                capabilities: {
                  temperature: false,
                  reasoning: true,
                  attachment: false,
                  toolcall: true,
                  input: { text: true, audio: false, image: false, video: false, pdf: false },
                  output: { text: true, audio: false, image: false, video: false, pdf: false },
                  interleaved: false,
                },
                // The vendor bills through the user's own subscription or key.
                cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
                limit: { context: 200_000, output: 32_000 },
                status: "active",
                options: {},
                headers: {},
                // No release date keeps every driver model visible in the picker.
                release_date: "",
                variants: Object.fromEntries(driver.variants.map((variant) => [variant, {}])),
              },
            ]),
          ),
        },
      ]),
    ]),
    connected: [...catalog.connected, ...drivers.filter((driver) => driver.available).map((driver) => driver.id)],
    default: { ...catalog.default, ...Object.fromEntries(drivers.map((driver) => [driver.id, driver.model])) },
  } satisfies ProviderListResponse
}

/** The config `model`, from the highest-priority document that sets one, as core's `Config.latest` reads it. */
export function configuredModel(entries: ReadonlyArray<ConfigEntry>) {
  const model = entries
    .flatMap((entry) => (entry.type === "document" && entry.info.model !== undefined ? [entry.info.model] : []))
    .at(-1)
  // The server sends the decoded selection, so the `provider/model` string form never arrives.
  if (typeof model !== "object") return
  return { providerID: model.providerID, modelID: model.model }
}

export function normalizeProjectInfo(project: Project | CurrentProject): Project {
  const worktree = "canonical" in project ? project.canonical : project.worktree
  return {
    ...project,
    worktree,
    worktrees: "worktrees" in project ? project.worktrees : [{ directory: worktree }],
    vcs: project.vcs === "git" ? "git" : undefined,
  }
}
