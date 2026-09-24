export * as CodeModeDiagnosticsStats from "./diagnostics-stats.js"

/**
 * Deterministic descriptive statistics for Code Mode diagnostics. Every function is pure, every
 * constant is published through `constants`, and nothing here fits or learns anything.
 */

/** Two-sided 95% normal quantile, used for Wilson score intervals. */
const Z95 = 1.96
/** Sessions each cohort needs before a rate comparison is reported as supported. */
const MIN_COHORT_SESSIONS = 20
/** Events each cohort needs before a rate comparison is reported as supported. */
const MIN_COHORT_EVENTS = 100
const ROUNDING = 4

export const constants = {
  z95: Z95,
  minCohortSessions: MIN_COHORT_SESSIONS,
  minCohortEvents: MIN_COHORT_EVENTS,
  rounding: ROUNDING,
}

export const round = (value: number) => Number(value.toFixed(ROUNDING))

/** Nearest-rank quantiles; deterministic and free of interpolation choices. */
export const quantiles = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((a, b) => a - b)
  const at = (q: number) =>
    sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!
  return {
    count: sorted.length,
    min: sorted[0] ?? null,
    p50: at(0.5),
    p90: at(0.9),
    max: sorted.at(-1) ?? null,
    mean: sorted.length === 0 ? null : round(sorted.reduce((total, value) => total + value, 0) / sorted.length),
  }
}

/** A proportion with its Wilson score interval, which stays inside [0, 1] for small counts. */
export const proportion = (numerator: number, denominator: number) => {
  if (denominator === 0) return { numerator, denominator, rate: null, low: null, high: null }
  const p = numerator / denominator
  const z2 = Z95 * Z95
  const center = (p + z2 / (2 * denominator)) / (1 + z2 / denominator)
  const spread =
    (Z95 * Math.sqrt((p * (1 - p)) / denominator + z2 / (4 * denominator * denominator))) / (1 + z2 / denominator)
  return {
    numerator,
    denominator,
    rate: round(p),
    low: round(Math.max(0, center - spread)),
    high: round(Math.min(1, center + spread)),
  }
}

export type Cohort = {
  readonly name: string
  readonly sessions: number
  readonly events: number
  readonly hits: number
}

/**
 * Risk difference and risk ratio between two cohorts, reported only when both meet the published
 * support thresholds. The comparison is observational: cohorts are not randomized.
 */
export const effect = (measure: string, a: Cohort, b: Cohort) => {
  const supported =
    a.sessions >= MIN_COHORT_SESSIONS &&
    b.sessions >= MIN_COHORT_SESSIONS &&
    a.events >= MIN_COHORT_EVENTS &&
    b.events >= MIN_COHORT_EVENTS
  const left = proportion(a.hits, a.events)
  const right = proportion(b.hits, b.events)
  return {
    measure,
    a: { name: a.name, sessions: a.sessions, ...left },
    b: { name: b.name, sessions: b.sessions, ...right },
    supported,
    ...(supported && left.rate !== null && right.rate !== null
      ? {
          riskDifference: round(left.rate - right.rate),
          riskRatio: right.rate === 0 ? null : round(left.rate / right.rate),
        }
      : {}),
    observational: true,
  }
}

/** Published weights for review-candidate ranking. Inputs are shares in [0, 1]; the score is their weighted sum. */
export const rankingWeights = {
  sessionShare: 0.35,
  holdoutShare: 0.25,
  unrecoveredRate: 0.2,
  evidenceQuality: 0.2,
} as const

export const rankingTieBreakers = [
  "score desc",
  "affectedSessions desc",
  "occurrences desc",
  "kind asc",
  "category asc",
] as const

export const score = (components: Readonly<Record<keyof typeof rankingWeights, number>>) =>
  round(
    (Object.keys(rankingWeights) as Array<keyof typeof rankingWeights>).reduce(
      (total, key) => total + rankingWeights[key] * components[key],
      0,
    ),
  )
