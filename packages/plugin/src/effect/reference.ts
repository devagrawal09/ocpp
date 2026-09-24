import type { ReferenceGitSource, ReferenceLocalSource } from "@ocpp/client"
import type { ReferenceApi } from "@ocpp/client/effect/api"
import type { Effect } from "effect"
import type { Transform } from "./registration.js"

export interface ReferenceDraft {
  add(name: string, source: ReferenceLocalSource | ReferenceGitSource): void
  remove(name: string): void
  list(): readonly (readonly [string, ReferenceLocalSource | ReferenceGitSource])[]
}

export interface ReferenceDomain extends ReferenceApi<unknown> {
  readonly transform: Transform<ReferenceDraft>
  readonly reload: () => Effect.Effect<void>
}
