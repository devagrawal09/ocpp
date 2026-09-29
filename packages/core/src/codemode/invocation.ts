export * as CodeModeInvocation from "./invocation.js"
export { InvocationError, Service, type Interface, type Started } from "./invocation-service.js"

import { CodeModeExecution } from "@ocpp/schema/codemode-execution"
import { Event } from "@ocpp/schema/event"
import { makeLocationNode } from "@ocpp/util/effect/app-node"
import { Clock, Effect, Exit, Layer, Schema } from "effect"
import { Agent } from "../agent.js"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { KeyedMutex } from "../effect/keyed-mutex.js"
import { Job } from "../job.js"
import { OpenApi } from "../openapi/index.js"
import { SessionEvent } from "../session/event.js"
import { SessionMessage } from "../session/message.js"
import { SessionStore } from "../session/store.js"
import { McpTool } from "../tool/mcp.js"
import { Tool } from "../tool.js"
import { ToolLists } from "../tool/lists.js"
import { CodeModeCommand } from "./command.js"
import { CodeModeEvent } from "./event.js"
import { CodeModeHandler } from "./handler.js"
import { InvocationError, type Interface, Service } from "./invocation-service.js"

const decodeStarted = Schema.decodeUnknownSync(Schema.Struct({ executionID: CodeModeExecution.ID }))

// Scheduled and manual firings of one event may race from different fibers, so the running check and
// the start are serialized per event across the process.
const firing = KeyedMutex.makeUnsafe<string>()

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const agents = yield* Agent.Service
    const bus = yield* Bus.Service
    const commands = yield* CodeModeCommand.Service
    const events = yield* CodeModeEvent.Service
    const jobs = yield* Job.Service
    const mcpTools = yield* McpTool.Service
    const openapi = yield* OpenApi.Service
    const registry = yield* Tool.Service
    const lists = yield* ToolLists.Service
    const sessions = yield* SessionStore.Service

    const run: Interface["run"] = Effect.fn("CodeModeInvocation.run")(function* (input) {
      const session = yield* sessions.get(input.sessionID)
      if (!session) return yield* new InvocationError({ message: `Session not found: ${input.sessionID}` })
      const problem = yield* CodeModeHandler.problem(db, input.sessionID, input.handler, false)
      if (problem) return yield* new InvocationError({ message: problem })
      const agent = yield* agents.select(session.agent)
      if (!agent.info) return yield* new InvocationError({ message: `Agent not found: ${agent.id}` })
      // Tools from MCP servers and OpenAPI documents load in the background; a run may call them.
      yield* mcpTools.flush
      yield* openapi.flush
      // A command or event runs with its Session's tool list for the Session's current agent.
      const snapshot = yield* registry.snapshot(yield* lists.select(session, agent.id), input.sessionID)
      const eventID = Event.ID.create()
      const messageID = SessionMessage.ID.fromEvent(eventID)
      const code = SessionMessage.invocationCode(input.handler, input.input)
      // Admission and the invocation message form one start: the execution waits for the message.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const result = yield* snapshot
            .execute({
              sessionID: input.sessionID,
              agent: agent.id,
              messageID,
              call: { type: "tool-call", id: messageID, name: "execute", input: { code } },
            })
            .pipe(Effect.mapError((error) => new InvocationError({ message: error.message })))
          const executionID = decodeStarted(result.output).executionID
          yield* bus
            .publish(
              SessionEvent.Invocation.Started,
              {
                sessionID: input.sessionID,
                executionID,
                trigger: input.trigger,
                handler: input.handler,
                input: input.input,
              },
              { id: eventID },
            )
            .pipe(Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : jobs.cancel(executionID))))
          return { executionID, messageID }
        }),
      )
    })

    const command: Interface["command"] = Effect.fn("CodeModeInvocation.command")(function* (input) {
      const defined = yield* commands.get(input.sessionID, input.name)
      if (!defined) return undefined
      return yield* run({
        sessionID: input.sessionID,
        trigger: { type: "command", name: defined.name, text: input.text },
        handler: defined.handler,
        input: { text: input.text, command: defined.name },
      })
    })

    const fire: Interface["fire"] = Effect.fn("CodeModeInvocation.fire")((input) => {
      const key = { sessionID: input.sessionID, name: input.name }
      return firing.withLock(input.sessionID + "/" + input.name)(
        Effect.gen(function* () {
          const event = yield* events.get(key)
          if (!event) return yield* new InvocationError({ message: `No event is named ${input.name}.` })
          const at = yield* Clock.currentTimeMillis
          const previous = event.execution_id ? yield* jobs.get(event.execution_id) : undefined
          if (previous?.status === "running") {
            yield* events.skipped(key, at)
            return { status: "skipped" as const }
          }
          const started = yield* run({
            sessionID: input.sessionID,
            trigger: { type: "event", name: input.name },
            handler: event.handler,
            input: { event: input.name, firedAt: new Date(at).toISOString(), input: input.input ?? event.input },
          }).pipe(Effect.tapError((error) => events.fired(key, { at, error: error.message })))
          yield* events.fired(key, { at, ...started })
          return { status: "started" as const, ...started }
        }),
      )
    })

    return Service.of({ run, command, fire })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Agent.node,
    Bus.node,
    CodeModeCommand.node,
    CodeModeEvent.node,
    Database.node,
    Job.node,
    McpTool.node,
    OpenApi.node,
    SessionStore.node,
    Tool.node,
    ToolLists.node,
  ],
})
