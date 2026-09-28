export * as ToolLists from "./lists.js"

import { makeLocationNode } from "@ocpp/util/effect/app-node"
import { FSUtil } from "@ocpp/util/fs-util"
import { Context, Effect, Layer } from "effect"
import path from "path"
import type { Agent } from "../agent.js"
import { Config } from "../config.js"
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
   * The init.ts program and the primary agent whose list it returns. Its tool.define handles live for one execution,
   * so each execution evaluates the program again.
   */
  readonly init?: { readonly source: string; readonly agent: string }
  /** Why the Session has no tools, such as an init.ts that cannot be read. */
  readonly error?: string
}

export const FILE = "init.ts"

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
   * The tools a Session's agent works with: a subagent's are the paths its caller passed, and a top-level Session's
   * come from init.ts for that agent, or from the built-in default without one.
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
    const runtime = yield* PluginRuntime.Service
    const reported = new Map<SessionSchema.ID, string>()

    // Config directories rank from lowest to highest priority, so the project's .ocpp/init.ts wins over the global
    // ~/.config/ocpp/init.ts. They are not merged.
    const discover = Effect.fnUntraced(function* (agent: Agent.ID) {
      const directories = (yield* config.entries()).flatMap((entry) =>
        entry.type === "directory" ? [entry.path] : [],
      )
      for (const directory of directories.toReversed()) {
        const file = path.join(directory, FILE)
        const text = yield* fs.readFileStringSafe(file).pipe(Effect.result)
        if (text._tag === "Failure") return { error: `${file} cannot be read: ${text.failure.message}` }
        if (text.success !== undefined) return { init: { source: text.success, agent } }
      }
      return defaults(agent)
    })

    return Service.of({
      select: Effect.fn("ToolLists.select")(function* (session, agent) {
        if (session.parentID !== undefined) return { paths: session.tools ?? [] }
        return yield* discover(agent)
      }),
      report: Effect.fn("ToolLists.report")(function* (sessionID, notice) {
        if (reported.get(sessionID) === notice) return
        if (notice === undefined) {
          reported.delete(sessionID)
          return
        }
        reported.set(sessionID, notice)
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
  deps: [Config.node, FSUtil.node, PluginRuntime.node],
})
