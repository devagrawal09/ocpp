export * as LocationMutation from "./location-mutation.js"

import { makeLocationNode } from "@ocpp/util/effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { FSUtil } from "@ocpp/util/fs-util"
import { Global } from "@ocpp/util/global"
import { Location } from "./location.js"

/**
 * Mutation paths do not accept project references. A leading `~` expands to
 * the home directory; other relative paths resolve from the active Location.
 */
export const ResolveInput = Schema.Struct({
  path: Schema.String,
})
export type ResolveInput = typeof ResolveInput.Type

export interface Target {
  /** Absolute lexical path. */
  readonly absolute: string
  /** How the path is shown: Location-relative for internal paths, absolute for external paths. */
  readonly resource: string
  /** The path is outside the Location and its non-root project worktree. */
  readonly external: boolean
}

export interface Interface {
  /**
   * Resolve a path and how it is shown. A leading `~` expands to the home
   * directory; other relative paths resolve from the Location.
   */
  readonly resolve: (input: ResolveInput) => Effect.Effect<Target>
}

/** Lexical absolute path, normalizing Windows shell paths and expanding `~` before resolution. */
export const resolvePath = (directory: string, input: string, home = Global.Path.home) => {
  const normalized = FSUtil.windowsPath(input)
  return path.resolve(
    directory,
    normalized === "~"
      ? home
      : normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))
        ? path.join(home, normalized.slice(2))
        : normalized,
  )
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/LocationMutation") {}

const slash = (value: string) => value.replaceAll("\\", "/")

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service

    const resolve = (input: ResolveInput) =>
      Effect.sync((): Target => {
        const absolute = resolvePath(location.directory, input.path)
        const worktree = path.resolve(location.project.directory)
        const internal =
          FSUtil.contains(location.directory, absolute) ||
          (worktree !== path.parse(worktree).root && FSUtil.contains(worktree, absolute))
        return {
          absolute,
          resource: slash(internal ? path.relative(location.directory, absolute) || "." : absolute),
          external: !internal,
        }
      })

    return Service.of({ resolve })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Location.node],
})
