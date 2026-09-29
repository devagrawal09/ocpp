type ModelKey = { providerID: string; modelID: string }

/**
 * The model a composer starts on: the first available of its own pick, its agent's model, the most recent pick, the
 * config `model` and the first connected model.
 */
export function composerModel(input: {
  pick?: ModelKey
  agent?: ModelKey
  recent: ReadonlyArray<ModelKey>
  configured?: ModelKey
  first?: ModelKey
  available: (model: ModelKey) => boolean
}) {
  return [input.pick, input.agent, ...input.recent, input.configured, input.first].find(
    (item): item is ModelKey => !!item && input.available(item),
  )
}
