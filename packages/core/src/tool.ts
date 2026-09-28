export * as Tool from "./tool.js"
export { CallID, Content, Error, FileContent, TextContent } from "@ocpp/schema/tool"
export type { Context, Info, Metadata, Options, Result } from "@ocpp/schema/tool"

import { ToolDefinition, type ToolCall } from "@ocpp/ai"
import { Tool } from "@ocpp/schema/tool"
import { Context, Effect, Layer, Result, Schema, SchemaIssue, Scope, Types } from "effect"
import { makeLocationNode } from "@ocpp/util/effect/app-node"
import type { Agent } from "./agent.js"
import type { Model } from "./model.js"
import { CodeModeCatalog } from "./codemode/catalog.js"
import { CodeModeStore } from "./codemode/store.js"
import { CodeModeTool } from "./codemode/tool.js"
import { Bus } from "./bus.js"
import { Image } from "./image.js"
import { PluginHooks } from "./plugin/hooks.js"
import { PluginRuntime } from "./plugin/runtime.js"
import { SessionMessage } from "./session/message.js"
import { SessionSchema } from "./session/schema.js"
import { State } from "./state.js"
import { ToolInit } from "./tool/init.js"
import { ToolLists } from "./tool/lists.js"
import { definition, effectiveName, execute, normalizedName, normalizeContent } from "./tool/runtime.js"
import { ToolSessionTools } from "./tool/session-tools.js"

export class RegistrationError extends Schema.TaggedError<RegistrationError>()("Tool.RegistrationError", {
  name: Schema.String,
  message: Schema.String,
}) {}

export interface Draft {
  readonly list: () => readonly (Tool.Info & { readonly id: string })[]
  readonly get: (id: string) => (Tool.Info & { readonly id: string }) | undefined
  readonly add: (tool: Tool.Info) => void
  readonly update: (id: string, update: (tool: Types.Mutable<Tool.Info>) => void) => void
  readonly remove: (id: string) => void
}

type Data = {
  tools: Map<string, Tool.Info & { readonly id: string }>
  errors: { tool: Tool.Info; error: RegistrationError }[]
}

export interface Interface extends State.Transformable<Draft> {
  readonly registerSession: (
    sessionID: SessionSchema.ID,
    tools: ReadonlyArray<Tool.Info>,
    options?: { readonly input?: Schema.Json },
  ) => Effect.Effect<State.Registration, RegistrationError>
  /** The tools a selection names, with the ones lent to the Session. Without a selection, every tool. */
  readonly registrations: (
    selection?: ToolLists.Selection,
    sessionID?: SessionSchema.ID,
  ) => Effect.Effect<ReadonlyArray<Tool.Info>>
  /**
   * The tools one request may call: exactly those its tool list selects, with the ones lent to the Session, shaped
   * by `tool` `catalog` hooks. `request` names the agent and model those hooks shape the catalog for; the model is
   * absent when no model request is involved. Without a selection, every tool.
   */
  readonly snapshot: (
    selection?: ToolLists.Selection,
    sessionID?: SessionSchema.ID,
    request?: { readonly agent: Agent.ID; readonly model?: Model.Ref },
  ) => Effect.Effect<Snapshot>
  /**
   * Resumes a Code Mode execution that was running when the host stopped, with the tool list it was admitted
   * with. Returns why it cannot resume safely instead of starting it.
   */
  readonly resume: (input: {
    readonly selection: ToolLists.Selection
    readonly agent: Agent.ID
    readonly resumable: CodeModeStore.Resumable
    readonly notificationID: SessionMessage.ID
  }) => Effect.Effect<string | undefined>
}

export interface Snapshot {
  readonly definitions: ReadonlyArray<ToolDefinition>
  readonly codeModeCatalog?: ReadonlyArray<CodeModeCatalog.Entry>
  /** A problem with the tool list, such as an init.ts that fails, for the Session to show. */
  readonly notice?: string
  /** The Code Mode paths the tool list selects, each with every tool under it; absent when it selects every tool. */
  readonly paths?: ReadonlyArray<string>
  readonly execute: (input: {
    readonly sessionID: SessionSchema.ID
    readonly agent: Agent.ID
    readonly messageID: SessionMessage.ID
    readonly call: ToolCall
    readonly progress?: (update: Tool.Metadata) => Effect.Effect<void>
    /** Surviving request definitions, keyed by the names advertised after session context hooks. */
    readonly definitions?: ReadonlyMap<string, ToolDefinition>
  }) => Effect.Effect<Tool.Result & { readonly content: ReadonlyArray<Tool.Content> }, Tool.Error>
}

export class Service extends Context.Service<Service, Interface>()("@ocpp/Tool") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const bus = yield* Bus.Service
    const image = yield* Image.Service
    const codemodeStore = yield* CodeModeStore.Service
    const runtime = yield* PluginRuntime.Service
    const scope = yield* Scope.Scope
    // Shared by every Location, so a Session placed in another Location than its caller's sees what it lends.
    const sessionTools = (yield* ToolSessionTools.Service).bySession

    const beforeExecute = (name: string, input: unknown, context: Tool.Context) =>
      hooks.trigger("tool", "execute.before", {
        tool: name,
        sessionID: context.sessionID,
        agent: context.agent,
        messageID: context.messageID,
        id: context.id,
        input,
      })
    const codemodeServices = { bus, jobs: runtime.job, sessions: runtime.session, image, store: codemodeStore, scope }

    const executeTool = Effect.fn("Tool.execute")(function* (
      tool: Tool.Info,
      name: string,
      input: unknown,
      context: Tool.Context,
    ) {
      const execution = yield* execute(tool, input, context).pipe(
        Effect.map((value) => ({ value })),
        Effect.catchTag("Tool.Error", (failure) => Effect.succeed({ failure })),
      )
      const base = {
        tool: name,
        sessionID: context.sessionID,
        agent: context.agent,
        messageID: context.messageID,
        id: context.id,
        input,
      }
      if ("failure" in execution) {
        const afterEvent: PluginHooks.Domains["tool"]["execute.after"] = {
          ...base,
          status: "error",
          error: execution.failure,
        }
        yield* hooks.trigger("tool", "execute.after", afterEvent)
        return yield* afterEvent.error
      }
      const afterEvent: PluginHooks.Domains["tool"]["execute.after"] = {
        ...base,
        status: "completed",
        result: {
          ...(execution.value.output === undefined ? {} : { output: execution.value.output }),
          content: execution.value.content,
          ...(execution.value.metadata === undefined ? {} : { metadata: execution.value.metadata }),
        },
      }
      yield* hooks.trigger("tool", "execute.after", afterEvent)
      return {
        ...(afterEvent.result.output === undefined ? {} : { output: afterEvent.result.output }),
        content: normalizeContent(afterEvent.result.content, afterEvent.result.output),
        ...(afterEvent.result.metadata === undefined ? {} : { metadata: afterEvent.result.metadata }),
      }
    })

    const executeCodeModeTool = (name: string, tool: Tool.Info, input: unknown, context: Tool.Context) =>
      beforeExecute(name, input, context).pipe(Effect.flatMap((event) => executeTool(tool, name, event.input, context)))

    const state: State.Interface<Data, Draft> = State.create<Data, Draft>({
      name: "tool",
      initial: () => ({
        tools: new Map(),
        errors: [],
      }),
      draft: (draft) => ({
        list: () => Array.from(draft.tools.values()),
        get: (id) => draft.tools.get(id),
        add: (tool) => {
          const error = registrationError(tool)
          if (error) {
            draft.errors.push({ tool, error })
            return
          }
          const id = effectiveName(tool)
          draft.tools.set(id, { ...tool, id, options: tool.options && { ...tool.options } })
        },
        update: (id, update) => {
          const current = draft.tools.get(id)
          if (!current) return
          const tool = { ...current, options: current.options && { ...current.options } }
          update(tool)
          tool.name = current.name
          tool.id = id
          if (tool.options?.namespace !== current.options?.namespace)
            tool.options = { ...tool.options, namespace: current.options?.namespace }
          const error = registrationError(tool)
          if (error) {
            draft.errors.push({ tool, error })
            return
          }
          draft.tools.set(id, tool)
        },
        remove: (id) => {
          draft.tools.delete(id)
        },
      }),
      finalize: () =>
        Effect.forEach(
          state.get().errors,
          ({ tool, error }) =>
            Effect.logError("Skipping invalid tool registration", {
              name: tool.name,
              namespace: tool.options?.namespace,
              error: error.message,
            }),
          { discard: true },
        ),
    })

    // The Location's own tools a selection names, then the tools its init.ts defines and those lent to the Session,
    // which take their names over.
    const listed = Effect.fnUntraced(function* (
      selection: ToolLists.Selection | undefined,
      sessionID: SessionSchema.ID | undefined,
      call?: ToolInit.Call,
    ) {
      const registry = state.get().tools
      const evaluated = selection?.init === undefined ? undefined : yield* ToolInit.evaluate(selection.init, registry, call)
      const error = selection?.error ?? (evaluated !== undefined && "error" in evaluated ? evaluated.error : undefined)
      if (error !== undefined)
        return {
          tools: new Map<string, Tool.Info>(),
          lent: new Set<string>(),
          notice: `${error} This session has no tools until that is fixed.`,
          paths: [],
        }
      const own = evaluated !== undefined && "paths" in evaluated ? evaluated : undefined
      const paths = own?.paths ?? selection?.paths
      const lent = [
        ...(own?.handles ?? []),
        ...(sessionID === undefined ? [] : (sessionTools.get(sessionID) ?? []).flatMap((item) => [...item.tools.values()])),
      ]
      return {
        tools: new Map([
          ...Array.from(registry).filter(([, tool]) => ToolLists.includes(paths, CodeModeTool.qualifiedName(tool))),
          ...lent.map((tool) => [effectiveName(tool), tool] as const),
        ]),
        lent: new Set(lent.map(effectiveName)),
        ...(own?.notice === undefined ? {} : { notice: own.notice }),
        ...(paths === undefined ? {} : { paths }),
      }
    })

    // Each execution evaluates init.ts again, so the handles it defines run tools in that execution and close with it.
    const handles =
      (selection: ToolLists.Selection) =>
      (context: Tool.Context): Effect.Effect<ReadonlyMap<string, Tool.Info>, never, Scope.Scope> =>
        Effect.gen(function* () {
          const catalog = new Map(
            Array.from(state.get().tools.values(), (tool) => [CodeModeTool.qualifiedName(tool), { tool, lent: false }]),
          )
          const own = yield* listed(selection, undefined, (name, tool, input, id) =>
            executeCodeModeTool(name, tool, input, {
              ...context,
              id: Tool.CallID.make(id),
              progress: () => Effect.void,
              ...(tool.options?.acceptsToolHandles === true ? { catalog } : {}),
            }).pipe(
              Effect.map((result) => {
                if (result.output !== undefined) return result.output
                const text = result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
                return text === "" ? null : text
              }),
            ),
          )
          return new Map(Array.from(own.tools).filter(([name]) => own.lent.has(name)))
        })

    // Plugins shape each request's Code Mode catalog: an edited description reaches the catalog and
    // tools.search, and a removed entry is neither listed nor callable.
    const catalogued = Effect.fnUntraced(function* (
      registrations: ReadonlyMap<string, Tool.Info>,
      sessionID?: SessionSchema.ID,
      request?: { readonly agent: Agent.ID; readonly model?: Model.Ref },
    ) {
      const paths = new Map(
        Array.from(registrations, ([name, tool]) => [CodeModeTool.qualifiedName(tool), { name, tool }]),
      )
      const event = yield* hooks.trigger("tool", "catalog", {
        ...(sessionID === undefined ? {} : { sessionID }),
        ...request,
        tools: Object.fromEntries(
          Array.from(paths, ([path, entry]) => [path, { description: entry.tool.description }]),
        ),
      })
      return new Map(
        Array.from(paths).flatMap(([path, entry]) => {
          const description = event.tools[path]?.description
          if (description === undefined) return []
          return [[entry.name, description === entry.tool.description ? entry.tool : { ...entry.tool, description }]]
        }),
      )
    })

    const activeInput = (sessionID?: SessionSchema.ID) =>
      sessionID === undefined
        ? undefined
        : (sessionTools.get(sessionID) ?? []).findLast((registration) => registration.input !== undefined)?.input

    const registerSession = Effect.fn("Tool.registerSession")(function* (
      sessionID: SessionSchema.ID,
      tools: ReadonlyArray<Tool.Info>,
      options?: { readonly input?: Schema.Json },
    ) {
      const registered = new Map<string, Tool.Info>()
      for (const tool of tools) {
        const error = registrationError(tool)
        if (error) return yield* error
        const id = effectiveName(tool)
        if (registered.has(id))
          return yield* new RegistrationError({ name: id, message: `Duplicate Session tool: ${id}` })
        registered.set(id, tool)
      }
      // Machine input is resolved for the Session by taking the single live registration that
      // carries it, so two concurrent input-bearing registrations for one Session would silently
      // cross-wire the wrong value into a child. Refuse the second one instead.
      if (options?.input !== undefined && (sessionTools.get(sessionID) ?? []).some((item) => item.input !== undefined))
        return yield* new RegistrationError({
          name: sessionID,
          message: `Machine input is already registered for Session: ${sessionID}`,
        })
      const token = Symbol(sessionID)
      sessionTools.set(sessionID, [
        ...(sessionTools.get(sessionID) ?? []),
        { token, tools: registered, ...(options?.input === undefined ? {} : { input: options.input }) },
      ])
      let disposed = false
      return {
        dispose: Effect.sync(() => {
          if (disposed) return
          disposed = true
          const next = (sessionTools.get(sessionID) ?? []).filter((item) => item.token !== token)
          if (next.length === 0) sessionTools.delete(sessionID)
          else sessionTools.set(sessionID, next)
        }),
      }
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      registerSession,
      resume: Effect.fn("Tool.resume")(function* (input) {
        const execution = input.resumable.execution
        const own = yield* Effect.scoped(listed(input.selection, execution.sessionID))
        return yield* CodeModeTool.resume(own.tools, executeCodeModeTool, codemodeServices, {
          context: {
            sessionID: execution.sessionID,
            agent: input.agent,
            messageID: execution.assistantMessageID,
            id: Tool.CallID.make(execution.toolCallID),
            progress: () => Effect.void,
          },
          resumable: input.resumable,
          notificationID: input.notificationID,
          lent: own.lent,
          ...(input.selection.init === undefined ? {} : { handles: handles(input.selection) }),
        })
      }),
      registrations: Effect.fn("Tool.registrations")(function* (selection, sessionID) {
        return Array.from((yield* Effect.scoped(listed(selection, sessionID))).tools.values())
      }),
      snapshot: Effect.fn("Tool.snapshot")(function* (selection, sessionID, request) {
        const own = yield* Effect.scoped(listed(selection, sessionID))
        const registrations = yield* catalogued(own.tools, sessionID, request)
        // `execute` is the only tool the model ever sees. Every tool is reachable only from code, so a
        // Session gets `execute` exactly when its tool list holds at least one tool.
        const codemodeTool =
          registrations.size === 0
            ? undefined
            : CodeModeTool.create(registrations, executeCodeModeTool, codemodeServices, {
                selection: selection ?? {},
                lent: own.lent,
                ...(activeInput(sessionID) === undefined ? {} : { input: activeInput(sessionID) }),
                ...(selection?.init === undefined ? {} : { handles: handles(selection) }),
              })
        return {
          ...(own.notice === undefined ? {} : { notice: own.notice }),
          ...(own.paths === undefined ? {} : { paths: own.paths }),
          ...(codemodeTool === undefined ? {} : { codeModeCatalog: CodeModeTool.catalog(registrations) }),
          definitions: codemodeTool ? [definition(codemodeTool)] : [],
          execute: Effect.fnUntraced(function* (input: Parameters<Snapshot["execute"]>[0]) {
            const context: Tool.Context = {
              sessionID: input.sessionID,
              agent: input.agent,
              messageID: input.messageID,
              id: Tool.CallID.make(input.call.id),
              progress: input.progress ?? (() => Effect.void),
            }
            const event = yield* beforeExecute(input.call.name, input.call.input, context)
            const requested = input.definitions?.get(event.tool)
            // Preserve session context removal and alias resolution, now after the repair hook.
            if (!requested && input.definitions && codemodeTool?.name === event.tool)
              return yield* new Tool.Error({ message: `Tool is not available for this request: ${event.tool}` })
            const name = requested?.name ?? event.tool
            if (name === "execute" && codemodeTool) return yield* executeTool(codemodeTool, name, event.input, context)
            return yield* new Tool.Error({ message: `Unknown tool: ${name}` })
          }),
        }
      }),
    })
  }),
)

const formatSchemaIssue = SchemaIssue.makeFormatterDefault()

function schemaMakeError(error: unknown) {
  if (error instanceof Error && SchemaIssue.isIssue(error.cause)) return formatSchemaIssue(error.cause)
  return error instanceof Error ? error.message : String(error)
}

function registrationError(tool: Tool.Info) {
  const namespace = tool.options?.namespace
  if (namespace !== undefined && !namespace.split(".").every((segment) => /^[A-Za-z0-9_-]{1,64}$/.test(segment)))
    return new RegistrationError({ name: namespace, message: `Invalid tool namespace: ${JSON.stringify(namespace)}` })
  const name = normalizedName(tool)
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) return new RegistrationError({ name, message: `Invalid tool name: ${name}` })
  const id = effectiveName(tool)
  if (id === "search") return new RegistrationError({ name: id, message: "Tool name is reserved for Code Mode: " + id })
  const result = Result.try({
    try: () => ToolDefinition.make(definition(tool)),
    catch: (error) =>
      new RegistrationError({ name: id, message: `Invalid tool definition ${id}: ${schemaMakeError(error)}` }),
  })
  return Result.isFailure(result) ? result.failure : undefined
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [PluginHooks.node, PluginRuntime.node, Bus.node, Image.node, CodeModeStore.node, ToolSessionTools.node],
})
