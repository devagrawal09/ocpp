import { Agent } from "@ocpp/core/agent"
import { Model } from "@ocpp/core/model"
import { Provider } from "@ocpp/core/provider"
import { Bus } from "@ocpp/core/bus"
import { CodeModeStore } from "@ocpp/core/codemode/store"
import { Job } from "@ocpp/core/job"
import type { Permission } from "@ocpp/core/permission"
import { SessionEvent } from "@ocpp/core/session/event"
import { SessionMessage } from "@ocpp/core/session/message"
import { CodeModeExecution } from "@ocpp/schema/codemode-execution"
import { toSessionError } from "@ocpp/core/session/to-session-error"
import type { SessionError } from "@ocpp/schema/session-error"
import { PluginHooks } from "@ocpp/core/plugin/hooks"
import { Tool } from "@ocpp/core/tool"
import { effectiveName, execute } from "@ocpp/core/tool/runtime"
import type { Context } from "@ocpp/plugin/effect/plugin"
import { DateTime, Effect, Option, Schema, type Scope } from "effect"
import { host } from "../plugin/host"
import { Database } from "@ocpp/core/database/database"
import { Project } from "@ocpp/core/project"
import { ProjectTable } from "@ocpp/core/project/sql"
import { AbsolutePath } from "@ocpp/core/schema"
import { SessionMessageTable, SessionTable } from "@ocpp/core/session/sql"

export const toolIdentity = {
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_tool_test"),
}

export const toolDefinitions = (registry: Tool.Interface, permissions?: Permission.Ruleset) =>
  registry.snapshot(permissions).pipe(Effect.map((toolSet) => toolSet.definitions))

/** Paths of the tools reachable from `execute`, which is the only tool the model is offered. */
export const codeModeTools = (registry: Tool.Interface, permissions?: Permission.Ruleset) =>
  registry.snapshot(permissions).pipe(Effect.map((toolSet) => (toolSet.codeModeCatalog ?? []).map((tool) => tool.path)))

/** Registered tools keyed by effective name, such as `acme_echo` for `tools.acme.echo`. */
export const registeredTools = (registry: Tool.Interface, permissions?: Permission.Ruleset) =>
  registry
    .registrations(permissions)
    .pipe(Effect.map((tools) => new Map(tools.map((tool) => [effectiveName(tool), tool]))))

export function waitForTool(registry: Tool.Interface, name: string, remaining = 1000): Effect.Effect<void, Error> {
  return Effect.gen(function* () {
    if ((yield* registeredTools(registry)).has(name)) return
    if (remaining === 0) {
      yield* Effect.fail(new Error(`Timed out waiting for tool: ${name}`))
      return
    }
    yield* Effect.promise(() => Bun.sleep(1))
    yield* waitForTool(registry, name, remaining - 1)
  })
}

const CodeModeOutput = Schema.Struct({ executionID: CodeModeExecution.ID, status: Schema.Literal("running") })

type CodeModeContext = {
  sessionID: Parameters<Tool.Snapshot["execute"]>[0]["sessionID"]
  assistantMessageID: SessionMessage.ID
  id: string
}

export const activateCodeMode = (output: unknown, context: CodeModeContext) =>
  Effect.gen(function* () {
    const value = Schema.decodeUnknownSync(CodeModeOutput)(output)
    const bus = yield* Bus.Service
    yield* bus.publish(SessionEvent.Tool.Success, {
      sessionID: context.sessionID,
      assistantMessageID: context.assistantMessageID,
      id: context.id,
      content: [{ type: "text", text: "Execution started" }],
      executed: false,
    })
    return value.executionID
  })

export const waitForCodeModeExecution = (executionID: CodeModeExecution.ID) =>
  Effect.gen(function* () {
    const jobs = yield* Job.Service
    const info = (yield* jobs.wait({ id: executionID })).info
    if (!info) return yield* Effect.die("Code Mode Job is unavailable")
    return info
  })

/** Terminal lifecycle information a model sees after an execution settles. */
export const readCodeModeOutcome = (executionID: CodeModeExecution.ID) =>
  Effect.gen(function* () {
    const store = yield* CodeModeStore.Service
    const execution = yield* store.get(executionID)
    if (!execution) return yield* Effect.die("Code Mode execution is unavailable")
    return execution
  })

export const readCodeModeNotebook = (sessionID: CodeModeContext["sessionID"]) =>
  Effect.gen(function* () {
    const store = yield* CodeModeStore.Service
    return yield* store.bindings(sessionID)
  })

export const waitForCodeMode = (output: unknown, context: CodeModeContext) =>
  Effect.gen(function* () {
    const executionID = yield* activateCodeMode(output, context)
    const info = yield* waitForCodeModeExecution(executionID)
    return { ...(yield* readCodeModeOutcome(executionID)), summary: info.output ?? info.error ?? "" }
  })

export function waitForCodeModeTool(
  registry: Tool.Interface,
  path: string,
  remaining = 1000,
): Effect.Effect<Tool.Snapshot, Error> {
  return Effect.gen(function* () {
    const toolSet = yield* registry.snapshot()
    if (toolSet.codeModeCatalog?.some((tool) => tool.path === path)) return toolSet
    if (remaining === 0) {
      return yield* Effect.fail(new Error(`Timed out waiting for Code Mode tool: ${path}`))
    }
    yield* Effect.promise(() => Bun.sleep(1))
    return yield* waitForCodeModeTool(registry, path, remaining - 1)
  })
}

/**
 * Registers a core tool plugin's tools against the real registry without booting the
 * full plugin host. Only the tool domain is live, including its catalog hooks; focused tool
 * tests exercise registration, snapshots, and execution through the same path production uses.
 */
export const registerToolPlugin = <R>(
  plugin: {
    readonly id: string
    readonly effect: (context: Context) => Effect.Effect<void, never, R>
  },
  overrides: Parameters<typeof host>[0] = {},
): Effect.Effect<void, never, R | Tool.Service | Scope.Scope> =>
  Effect.gen(function* () {
    const tools = yield* Tool.Service
    // Only plugins that customize the catalog need hooks, so only their tests list PluginHooks.node.
    const hooks = Option.getOrUndefined(yield* Effect.serviceOption(PluginHooks.Service))
    const context = host({
      ...overrides,
      session: {
        hook: () => Effect.succeed({ dispose: Effect.void }),
      },
      tool: {
        transform: tools.transform,
        reload: tools.reload,
        hook: (name, callback) =>
          hooks === undefined
            ? Effect.die("registerToolPlugin registers tool hooks only when PluginHooks.node is a dependency")
            : hooks.register("tool", name, callback),
      },
    })
    yield* plugin.effect(context)
  })

export interface ToolExecution {
  readonly status: "completed" | "error"
  readonly output?: any
  readonly content?: ReadonlyArray<Tool.Content>
  readonly metadata?: Tool.Metadata
  readonly error?: SessionError.Error
}

export const seedToolSession = Effect.fnUntraced(function* (
  sessionID: Parameters<Tool.Snapshot["execute"]>[0]["sessionID"],
  messageID?: SessionMessage.ID,
) {
  const database = Option.getOrUndefined(yield* Effect.serviceOption(Database.Service))
  if (!database) return
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: sessionID,
      directory: AbsolutePath.make("/project"),
      title: sessionID,
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  // Code Mode saves only into the history that admitted it, so tests that run an execution seed the
  // assistant message it was admitted from.
  if (!messageID) return
  const encoded = Schema.encodeSync(SessionMessage.Info)(
    SessionMessage.Assistant.make({
      id: messageID,
      type: "assistant",
      agent: toolIdentity.agent,
      model: { id: Model.ID.make("model"), providerID: Provider.ID.make("provider") },
      content: [],
      time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(1) },
    }),
  )
  const { id: _id, type, ...data } = encoded
  yield* database.db
    .insert(SessionMessageTable)
    .values({ id: messageID, session_id: sessionID, type, seq: 1, time_created: 1, data })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

/**
 * Runs `execute` through the model-facing snapshot, and any other registered tool through the leaf
 * runtime that Code Mode calls. The model never calls a registered tool directly, so focused tool
 * tests exercise the leaf without admitting a program.
 */
export const executeTool = (
  registry: Tool.Interface,
  input: Parameters<Tool.Snapshot["execute"]>[0],
): Effect.Effect<ToolExecution> =>
  Effect.gen(function* () {
    yield* seedToolSession(input.sessionID)
    if (input.call.name === "execute")
      return yield* registry.snapshot().pipe(Effect.flatMap((tools) => tools.execute(input)))
    const tool = (yield* registry.registrations(undefined, input.sessionID)).find(
      (tool) => effectiveName(tool) === input.call.name,
    )
    if (!tool) return yield* new Tool.Error({ message: `Unknown tool: ${input.call.name}` })
    return yield* execute(tool, input.call.input, {
      sessionID: input.sessionID,
      agent: input.agent,
      messageID: input.messageID,
      id: Tool.CallID.make(input.call.id),
      progress: input.progress ?? (() => Effect.void),
    })
  }).pipe(
    Effect.map((result) => ({ status: "completed" as const, ...result }) satisfies ToolExecution),
    Effect.catchTag("Tool.Error", (error) =>
      Effect.succeed({ status: "error" as const, error: toSessionError(error) } satisfies ToolExecution),
    ),
  )
