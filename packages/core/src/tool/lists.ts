export * as ToolLists from "./lists.js"

import { makeLocationNode } from "@ocpp/util/effect/app-node"
import { FSUtil } from "@ocpp/util/fs-util"
import { Context, Effect, Layer } from "effect"
import path from "path"
import type { Agent } from "../agent.js"
import { Config } from "../config.js"
import { Location } from "../location.js"
import { PluginRuntime } from "../plugin/runtime.js"
import type { SessionSchema } from "../session/schema.js"

/**
 * What one Session's Code Mode catalog holds. It is plain data: an execution stores the selection it was admitted
 * with, so a resumed run rebuilds the same catalog.
 */
export type Selection = {
  /** Code Mode paths; each selects the tool at that path and every tool under it. Absent selects every tool. */
  readonly paths?: ReadonlyArray<string>
  /**
   * The init.ts program, the file it was read from, and the primary agent whose list it returns. Its tool.define
   * handles live for one execution, so each execution evaluates the program again.
   */
  readonly init?: { readonly source: string; readonly agent: string; readonly file?: string }
  /** Why the Session has no tools, such as an init.ts that cannot be read. */
  readonly error?: string
}

export const FILE = "init.ts"

const MAX_REPORTED = 1_000

// Read, search and ask: plan mode inspects and plans without changing anything.
const PLAN = ["read", "glob", "grep", "webfetch", "websearch", "skill", "question", "subagent"]

/** The built-in lists without an init.ts: plan reads, searches and asks, and every other agent gets every tool. */
export function defaults(agent: string): Selection {
  return agent === "plan" ? { paths: PLAN } : {}
}

/** Whether a selection's paths include a catalog path: the path itself, or one under a selected namespace. */
export function includes(paths: ReadonlyArray<string> | undefined, candidate: string) {
  return paths === undefined || paths.some((item) => candidate === item || candidate.startsWith(item + "."))
}

export interface Interface {
  /**
   * The tools a Session's agent works with: a Session that stores a list, such as a subagent or a fork of one, has the
   * paths stored, and any other top-level Session gets init.ts's list for that agent, or the built-in default without
   * one.
   */
  readonly select: (session: SessionSchema.Info, agent: Agent.ID) => Effect.Effect<Selection>
  /**
   * Shows a problem with a Session's tool list in its timeline once, until the problem changes; undefined clears it.
   */
  readonly report: (sessionID: SessionSchema.ID, notice: string | undefined) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/ToolLists") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    const runtime = yield* PluginRuntime.Service
    const reported = new Map<SessionSchema.ID, string>()

    // The nearest project .ocpp/init.ts wins over those further up and over the global ~/.config/ocpp/init.ts; they
    // are not merged. The files are probed at each selection, from the Location's directory up to its worktree root,
    // because a project .ocpp created after the Location discovered its config is not among the config's directories.
    // Config directories rank from lowest to highest priority.
    const discover = Effect.fnUntraced(function* (agent: Agent.ID) {
      const nearby = yield* fs
        .up({ targets: [path.join(".ocpp", FILE)], start: location.directory, stop: location.project.directory })
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []))
      const configured = (yield* config.entries())
        .flatMap((entry) => (entry.type === "directory" ? [path.join(entry.path, FILE)] : []))
        .toReversed()
      for (const file of new Set([...nearby, ...configured])) {
        const text = yield* fs.readFileStringSafe(file).pipe(Effect.result)
        if (text._tag === "Failure") return { error: `${file} cannot be read: ${text.failure.message}` }
        if (text.success !== undefined) return { init: { source: text.success, agent, file } }
      }
      return defaults(agent)
    })

    return Service.of({
      select: Effect.fn("ToolLists.select")(function* (session, agent) {
        // A child without a stored list has no tools rather than init.ts's.
        if (session.tools !== undefined || session.parentID !== undefined) return { paths: session.tools ?? [] }
        return yield* discover(agent)
      }),
      report: Effect.fn("ToolLists.report")(function* (sessionID, notice) {
        if (reported.get(sessionID) === notice) return
        if (notice === undefined) {
          reported.delete(sessionID)
          return
        }
        reported.set(sessionID, notice)
        // Only the Sessions that last showed a problem are remembered; one that falls out may show it once more.
        if (reported.size > MAX_REPORTED) reported.delete(reported.keys().next().value!)
        yield* runtime.session
          .synthetic({ sessionID, text: notice, description: notice.split("\n")[0], resume: false })
          .pipe(Effect.catchCause((cause) => Effect.logWarning("failed to report a tool list problem", { cause })))
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Config.node, FSUtil.node, Location.node, PluginRuntime.node],
})
