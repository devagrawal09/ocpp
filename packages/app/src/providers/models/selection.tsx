import { createSimpleContext } from "@ocpp/ui/context"
import { base64Encode } from "@ocpp/util/encode"
import { useParams } from "@solidjs/router"
import { batch, createEffect, createMemo, startTransition } from "solid-js"
import { createStore } from "solid-js/store"
import { useModels } from "@/providers/models/models"
import { useSettings } from "@/settings/model"
import { useProviders } from "@/providers/catalog/providers"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { hasCustomAgent, resolveAgent } from "./agent"
import { composerModel, describeModel } from "./composer-model"
import { cycleModelVariant, getConfiguredAgentVariant, resolveModelVariant } from "./variant"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useData } from "@/runtime/server/current"
import { normalizeAgentList } from "@/runtime/server/global-sync/utils"
import { useServerSDK } from "@/runtime/server/client"
import { ScopedKey, type ServerScope } from "@/runtime/server/scope"
import { resolveSessionComposerSelection } from "@/session/composer/selection"

export type ModelKey = { providerID: string; modelID: string; variant?: string }

type State = {
  agent?: string
  model?: ModelKey
  variant?: string | null
}

type Saved = {
  // Since version 2 an entry holds only what the user picked for a Session, never a copy of the model it stores.
  version: 2
  session: Record<string, State | undefined>
}

const handoff = new Map<string, State>()

const handoffKey = (scope: ServerScope, dir: string, id: string) => ScopedKey.from(scope, dir, id)

// Older entries mixed real picks with copies of a Session's stored model and with the fallback the composer showed
// in its place, which cannot be told apart. They are dropped once, so every Session shows its stored model again.
export const migrateModelSelection = (value: unknown) =>
  value && typeof value === "object" && "version" in value && value.version === 2 ? value : { version: 2, session: {} }

const clone = (value: State | undefined) => {
  if (!value) return
  return {
    ...value,
    model: value.model ? { ...value.model } : undefined,
  } satisfies State
}

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const params = useParams()
    const sdk = useWorkspaceLocation()
    const data = useData()
    const serverSDK = useServerSDK()
    const providers = useProviders(() => sdk().directory)
    const models = useModels()
    const settings = useSettings()

    const id = createMemo(() => params.id || undefined)
    const list = createMemo(() =>
      normalizeAgentList(data.location.agent.list({ directory: sdk().directory }) ?? []).filter(
        (item) => item.mode !== "subagent" && !item.hidden,
      ),
    )
    const agentsVisible = createMemo(() => settings.visibility.customAgents() || hasCustomAgent(list()))
    const connected = createMemo(() => new Set(providers.connected().map((item) => item.id)))

    const [saved, setSaved, , savedReady] = persisted(
      {
        ...Persist.serverWorkspace(serverSDK.scope, sdk().directory, "model-selection"),
        migrate: migrateModelSelection,
      },
      createStore<Saved>({
        version: 2,
        session: {},
      }),
    )

    const [store, setStore] = createStore<{
      current?: string
      draft?: State
      promoting?: State
      last?: {
        type: "agent" | "model" | "variant"
        agent?: string
        model?: ModelKey | null
        variant?: string | null
      }
    }>({
      current: list()[0]?.name,
      draft: undefined,
      last: undefined,
    })

    const validModel = (model: ModelKey) => {
      const provider = providers.all().get(model.providerID)
      return !!provider?.models[model.modelID] && connected().has(model.providerID)
    }

    const pickAgent = (name: string | undefined) => {
      return resolveAgent(list(), name)
    }

    createEffect(() => {
      const items = list()
      if (items.length === 0) {
        if (store.current !== undefined) setStore("current", undefined)
        return
      }
      if (items.some((item) => item.name === store.current)) return
      setStore("current", items[0]?.name)
    })

    // What the open Session records: its agent and the model it runs on. `scope` holds only what the user picked.
    const stored = createMemo(() => {
      const session = id()
      return session ? resolveSessionComposerSelection(data.session.get(session), undefined) : undefined
    })

    const scope = createMemo<State | undefined>(() => {
      const session = id()
      if (!session) return store.draft ?? store.promoting
      return saved.session[session] ?? handoff.get(handoffKey(serverSDK.scope, sdk().directory, session))
    })

    createEffect(() => {
      const session = id()
      if (!session) return

      const key = handoffKey(serverSDK.scope, sdk().directory, session)
      const next = handoff.get(key)
      if (!next) return
      if (saved.session[session] !== undefined) {
        handoff.delete(key)
        setStore("promoting", undefined)
        return
      }

      setSaved("session", session, clone(next))
      handoff.delete(key)
      setStore("promoting", undefined)
    })

    const defaultModel = () => {
      for (const provider of providers.connected()) {
        const first = Object.values(provider.models)[0]
        if (!first) continue
        const model = { providerID: provider.id, modelID: first.id }
        if (validModel(model)) return model
      }
    }

    const agent = {
      list,
      visible: agentsVisible,
      current() {
        return pickAgent(agentsVisible() ? (scope()?.agent ?? stored()?.agent ?? store.current) : "build")
      },
      set(name: string | undefined) {
        const item = pickAgent(name)
        if (!item) {
          setStore("current", undefined)
          return
        }

        batch(() => {
          setStore("current", item.name)
          setStore("last", {
            type: "agent",
            agent: item.name,
            model: item.model,
            variant: item.variant ?? null,
          })
          const prev = scope()
          const next = {
            agent: item.name,
            model: item.model ?? prev?.model,
            variant: item.variant ?? prev?.variant,
          } satisfies State
          const session = id()
          if (session) {
            setSaved("session", session, next)
            return
          }
          setStore("draft", next)
        })
      },
      move(direction: 1 | -1) {
        const items = list()
        if (items.length === 0) {
          setStore("current", undefined)
          return
        }

        let next = items.findIndex((item) => item.name === agent.current()?.name) + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0
        const item = items[next]
        if (!item) return
        agent.set(item.name)
      },
    }

    const selected = () => {
      const pick = scope()
      return pick?.variant !== undefined ? pick.variant : stored()?.model?.variant
    }

    const current = createMemo(() => {
      const item = composerModel({
        session: id() ? (scope()?.model ?? stored()?.model) : undefined,
        pick: scope()?.model,
        agent: agent.current()?.model,
        recent: models.recent.list(),
        configured: providers.configured(),
        first: defaultModel(),
        available: validModel,
      })
      if (!item) return
      return models.find(item) ?? describeModel({ ...item, variant: selected() }, providers.all().get(item.providerID))
    })

    const configured = () => {
      const item = agent.current()
      const model = current()
      if (!item || !model) return
      return getConfiguredAgentVariant({
        agent: { model: item.model, variant: item.variant },
        model: { providerID: model.provider.id, modelID: model.id, variants: model.variants },
      })
    }

    const snapshot = () => {
      const model = current()
      return {
        agent: agent.current()?.name,
        model: model ? { providerID: model.provider.id, modelID: model.id } : undefined,
        variant: selected(),
      } satisfies State
    }

    const write = (next: Partial<State>) => {
      const state = {
        ...(scope() ?? { agent: agent.current()?.name }),
        ...next,
      } satisfies State

      const session = id()
      if (session) {
        setSaved("session", session, state)
        return
      }
      setStore("draft", state)
    }

    const recent = createMemo(() => models.recent.list().map(models.find).filter(Boolean))

    const model = {
      ready: models.ready,
      current,
      recent,
      list: models.list,
      cycle(direction: 1 | -1) {
        const items = recent()
        const item = current()
        if (!item) return

        const index = items.findIndex((entry) => entry?.provider.id === item.provider.id && entry?.id === item.id)
        if (index === -1) return

        let next = index + direction
        if (next < 0) next = items.length - 1
        if (next >= items.length) next = 0

        const entry = items[next]
        if (!entry) return
        model.set({ providerID: entry.provider.id, modelID: entry.id })
      },
      set(item: ModelKey | undefined, options?: { recent?: boolean }) {
        startTransition(() =>
          batch(() => {
            setStore("last", {
              type: "model",
              agent: agent.current()?.name,
              model: item ?? null,
              variant: selected(),
            })
            write({ model: item })
            if (!item) return
            models.setVisibility(item, true)
            if (!options?.recent) return
            models.recent.push(item)
          }),
        )
      },
      visible(item: ModelKey) {
        return models.visible(item)
      },
      setVisibility(item: ModelKey, visible: boolean) {
        models.setVisibility(item, visible)
      },
      variant: {
        configured,
        selected,
        current() {
          const resolved = resolveModelVariant({
            variants: this.list(),
            selected: this.selected(),
            configured: this.configured(),
          })
          if (resolved) return resolved
          const model = current()
          if (!model) return
          const saved = models.variant.get({ providerID: model.provider.id, modelID: model.id })
          if (saved && this.list().includes(saved)) return saved
        },
        list() {
          const item = current()
          if (!item?.variants) return []
          return Object.keys(item.variants)
        },
        set(value: string | undefined) {
          startTransition(() =>
            batch(() => {
              const model = current()
              setStore("last", {
                type: "variant",
                agent: agent.current()?.name,
                model: model ? { providerID: model.provider.id, modelID: model.id } : null,
                variant: value ?? null,
              })
              write({ variant: value ?? null })
              if (model) {
                models.variant.set({ providerID: model.provider.id, modelID: model.id }, value ?? undefined)
              }
            }),
          )
        },
        cycle() {
          const items = this.list()
          if (items.length === 0) return
          this.set(
            cycleModelVariant({
              variants: items,
              selected: this.selected(),
              configured: this.configured(),
            }),
          )
        },
      },
    }

    const result = {
      slug: createMemo(() => base64Encode(sdk().directory)),
      model,
      agent,
      session: {
        ready: savedReady,
        reset() {
          setStore({ draft: undefined, promoting: undefined })
        },
        promote(dir: string, session: string, state?: State) {
          const next = clone(state ?? snapshot())
          if (!next) return
          const key = handoffKey(serverSDK.scope, dir, session)
          handoff.set(key, next)

          if (dir === sdk().directory) {
            setSaved("session", session, next)
          }

          setStore("promoting", next)
          setStore("draft", undefined)
        },
      },
    }
    return result
  },
})

export type ModelSelection = ReturnType<typeof useLocal>["model"]
