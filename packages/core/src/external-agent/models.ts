export * as ExternalAgentModels from "./models.js"

/** A model as its vendor CLI lists it. */
export interface Model {
  readonly id: string
  /** Offered in the vendor's own model picker. Hidden models still run when named. */
  readonly listed: boolean
  readonly efforts: ReadonlyArray<string>
  /** The model the vendor says replaces this one, and why. */
  readonly upgrade?: { readonly id: string; readonly message?: string }
}

/** A versioned ID such as `gpt-6.1-sol`: its alias `sol` and version `[6, 1]`. */
function versioned(id: string) {
  const [family, version, alias, ...rest] = id.split("-")
  if (family !== "gpt" || alias === undefined || rest.length > 0 || !/^\d+(\.\d+)*$/.test(version)) return undefined
  return { alias, version: version.split(".").map(Number) }
}

function compare(a: ReadonlyArray<number>, b: ReadonlyArray<number>) {
  return (
    Array.from({ length: Math.max(a.length, b.length) }, (_, index) => (a[index] ?? 0) - (b[index] ?? 0)).find(
      (difference) => difference !== 0,
    ) ?? 0
  )
}

/** Each alias with the newest listed model it names, such as `sol` with `gpt-6.1-sol`, in the vendor's order. */
export function aliases(models: ReadonlyArray<Model>) {
  return models.reduce<Record<string, string>>((result, model) => {
    const named = model.listed ? versioned(model.id) : undefined
    if (named === undefined) return result
    const current = result[named.alias]
    if (current !== undefined && compare(versioned(current)!.version, named.version) >= 0) return result
    return { ...result, [named.alias]: model.id }
  }, {})
}

/** The model an ID runs: an alias's newest model, else the ID as given. */
export function resolve(id: string, models: ReadonlyArray<Model>) {
  const named = aliases(models)
  return Object.hasOwn(named, id) ? named[id] : id
}

/**
 * A newer model than a pinned ID: the vendor's named upgrade, else the newest model of the same alias. Undefined for
 * an alias, which always runs its newest model.
 */
export function newer(id: string, models: ReadonlyArray<Model>) {
  const upgrade = models.find((model) => model.id === id)?.upgrade
  const named = versioned(upgrade?.id ?? id)
  const latest = named === undefined ? undefined : aliases(models)[named.alias]
  const target = latest ?? upgrade?.id
  if (target === undefined || target === id) return undefined
  if (upgrade === undefined && compare(versioned(target)!.version, versioned(id)!.version) <= 0) return undefined
  return {
    id: target,
    ...(named !== undefined && latest !== undefined ? { alias: named.alias } : {}),
    ...(upgrade?.message === undefined ? {} : { message: upgrade.message }),
  }
}
