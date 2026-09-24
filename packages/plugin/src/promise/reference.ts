import type { ReferenceApi } from "@ocpp/client/promise/api"
import type { ReferenceGitSource, ReferenceLocalSource } from "@ocpp/client"
import type { Transform } from "./registration.js"

export interface ReferenceDraft {
  add(name: string, source: ReferenceLocalSource | ReferenceGitSource): void
  remove(name: string): void
  list(): readonly (readonly [string, ReferenceLocalSource | ReferenceGitSource])[]
}

export interface ReferenceDomain extends ReferenceApi {
  readonly transform: Transform<ReferenceDraft>
  readonly reload: () => Promise<void>
}
