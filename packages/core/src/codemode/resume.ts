export * as CodeModeResume from "./resume.js"

import { makeGlobalNode } from "@ocpp/util/effect/app-node"
import { Context, Effect, Layer } from "effect"
import { Agent } from "../agent.js"
import { LocationServiceMap } from "../location-service-map.js"
import { OpenApi } from "../openapi/index.js"
import { PluginSupervisor } from "../plugin/supervisor.js"
import { SessionMessage } from "../session/message.js"
import { SessionStore } from "../session/store.js"
import { McpTool } from "../tool/mcp.js"
import { Tool } from "../tool.js"
import { CodeModeStore } from "./store.js"

/** Resumes of one execution before restart recovery stops resuming it, so a run that kills its host cannot loop. */
const MAX_RESUMES = 3

export type Outcome = { readonly resumed: true } | { readonly resumed: false; readonly reason: string }

export interface Interface {
  /**
   * Resumes a Code Mode execution whose job was running when the host stopped, reporting its outcome
   * through the same completion notification. An execution that cannot resume safely is settled
   * indeterminate, and the reason says why.
   */
  readonly resume: (input: {
    readonly executionID: string
    readonly notificationID: SessionMessage.ID
  }) => Effect.Effect<Outcome>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/CodeModeResume") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* CodeModeStore.Service
    const sessions = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service

    const resume: Interface["resume"] = Effect.fn("CodeModeResume.resume")(function* (input) {
      const resumable = yield* store.resume(input.executionID)
      if (resumable === undefined)
        return { resumed: false as const, reason: "Execution failed because the server restarted." }
      const execution = resumable.execution
      const refused = yield* Effect.gen(function* () {
        if (resumable.resumes > MAX_RESUMES) return "It was already resumed " + MAX_RESUMES + " times without settling."
        if (resumable.missing.length > 0)
          return "Notebook values it read no longer exist: " + resumable.missing.join(", ") + "."
        const session = yield* sessions.get(execution.sessionID)
        if (session === undefined) return "Its Session no longer exists."
        const started = (yield* sessions.message(execution.assistantMessageID))?.message
        if (started?.type !== "assistant" && started?.type !== "invocation")
          return "The message that started it no longer exists."
        return yield* Effect.gen(function* () {
          const plugins = yield* PluginSupervisor.Service
          const mcp = yield* McpTool.Service
          const openapi = yield* OpenApi.Service
          const agents = yield* Agent.Service
          const tools = yield* Tool.Service
          // Replay needs every tool the execution could call, including plugin, MCP, and OpenAPI tools.
          yield* plugins.flush
          yield* mcp.flush
          yield* openapi.flush
          // A command or event runs with the Session agent's tools, as it did when it started.
          const agent = yield* agents.select(started.type === "assistant" ? started.agent : session.agent)
          if (agent.info === undefined) return "Its agent " + agent.id + " no longer exists."
          return yield* tools.resume({
            permissions: agent.info.permissions,
            agent: agent.id,
            resumable,
            notificationID: input.notificationID,
          })
        }).pipe(
          Effect.provide(locations.get(session.location)),
          Effect.catch(() => Effect.succeed("Its location could not be loaded.")),
        )
      })
      if (refused === undefined) return { resumed: true as const }
      const reason =
        "Execution " + execution.id + " could not resume after the server restarted and saved nothing. " + refused
      yield* store.indeterminate(execution, reason)
      return { resumed: false as const, reason }
    })

    return Service.of({ resume })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [CodeModeStore.node, SessionStore.node, LocationServiceMap.node],
})
