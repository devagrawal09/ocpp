import { resolveSessionComposerSelection } from "./composer/selection"

type Local = {
  session: {
    reset(): void
    restore(msg: {
      sessionID: string
      agent?: string
      model: { providerID: string; modelID: string; variant?: string }
    }): void
  }
}

type ModelSelection = {
  model: {
    current(): { id: string; provider: { id: string } } | undefined
    set(model: { providerID: string; modelID: string }): void
    variant: {
      current(): string | undefined
      set(variant: string | undefined): void
    }
  }
}

type PromptState = {
  model: {
    current(): { providerID: string; modelID: string; variant?: string | null } | undefined
    set(model: { providerID: string; modelID: string; variant?: string | null }): void
  }
}

export const resetSessionModel = (local: Local) => {
  local.session.reset()
}

export const syncSessionModel = (
  local: Local,
  info: { id: string; agent?: string; model?: { id: string; providerID: string; variant?: string } } | undefined,
  metadata: Record<string, unknown> | undefined,
) => {
  const selection = resolveSessionComposerSelection(info, metadata)
  // A Session created through the API may record no agent, and its prompts no metadata. Its model must still
  // reach the composer, or the composer falls back to another model and the next prompt switches to it.
  if (!info || !selection.model) return
  local.session.restore({ sessionID: info.id, agent: selection.agent, model: selection.model })
}

export const syncPromptModel = (local: ModelSelection, prompt: PromptState) => {
  const model = local.model.current()
  if (!model) return
  const next = {
    providerID: model.provider.id,
    modelID: model.id,
    variant: local.model.variant.current(),
  }
  const current = prompt.model.current()
  if (current?.providerID === next.providerID && current.modelID === next.modelID && current.variant === next.variant)
    return
  prompt.model.set(next)
}

export const restorePromptModel = (local: ModelSelection, prompt: PromptState) => {
  const model = prompt.model.current()
  if (!model) return false
  const current = local.model.current()
  if (
    current?.provider.id === model.providerID &&
    current.id === model.modelID &&
    local.model.variant.current() === (model.variant ?? undefined)
  )
    return true
  local.model.set({ providerID: model.providerID, modelID: model.modelID })
  local.model.variant.set(model.variant ?? undefined)
  return true
}
