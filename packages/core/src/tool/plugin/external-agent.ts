export * as ExternalAgentTool from "./external-agent.js"

import { available, driver } from "#external-agents"
import { ToolFailure } from "@ocpp/ai"
import type { Context } from "@ocpp/plugin/effect/plugin"
import { ExternalSession } from "@ocpp/schema/external-session"
import { Model } from "@ocpp/schema/model"
import { Provider } from "@ocpp/schema/provider"
import { Hash } from "@ocpp/util/hash"
import { FSUtil } from "@ocpp/util/fs-util"
import { Cause, Effect, Schema, Stream } from "effect"
import path from "path"
import { Agent } from "../../agent.js"
import { Wildcard } from "../../util/wildcard.js"
import { Config } from "../../config.js"
import { ExternalAgentDriver } from "../../external-agent/driver.js"
import { ExternalAgentGateway } from "../../external-agent/gateway.js"
import { ExternalAgentSession } from "../../external-agent/session.js"
import { ExternalAgentStream } from "../../external-agent/stream.js"
import { Bus } from "../../bus.js"
import { LocationMutation } from "../../location-mutation.js"
import { Permission } from "../../permission.js"
import { PluginRuntime } from "../../plugin/runtime.js"
import { AbsolutePath } from "../../schema.js"
import { StepFailedError } from "../../session/error.js"
import { SessionEvent } from "../../session/event.js"
import { SessionMessage } from "../../session/message.js"
import { SessionSchema } from "../../session/schema.js"
import { toSessionError } from "../../session/to-session-error.js"
import { Tool } from "../../tool.js"
import { SubagentCustomTool } from "./subagent-custom.js"

export const Input = Schema.Struct({
  root: Schema.String.annotate({
    description:
      "Existing absolute root directory for this call, including an external git worktree. Requires OC++ permission.",
  }),
  description: Schema.String,
  message: Schema.String,
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  sessionID: Schema.optionalKey(SessionSchema.ID),
  input: Schema.optionalKey(Schema.Json).annotate({
    description:
      "Private machine data, available only as input in the child's execute tool. Never rendered into either model context.",
  }),
  inputSchema: Schema.optionalKey(SubagentCustomTool.JSONSchema),
  tools: Schema.optionalKey(Schema.Array(Schema.Unknown)).annotate({
    description: "Opaque tool.define handles; delegated capabilities remain limited to their parent activation.",
  }),
  outputSchema: Schema.optionalKey(SubagentCustomTool.JSONSchema).annotate({
    description:
      "Required result schema. The child must call submit_result. The output is returned only as machine data; message is shown to the parent.",
  }),
})
export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literal("completed"),
  message: Schema.String,
  output: Schema.Json,
})
const defaults = { claude: "sonnet", codex: "gpt-5.6-sol", pi: "anthropic/claude-sonnet-4-6" }

export function make(platform: { available: typeof available; driver: typeof driver } = { available, driver }) {
  return {
    id: "ocpp.tool.external-agent",
    effect: Effect.fn("ExternalAgentTool.Plugin")(function* (ctx: Context) {
      const runtime = yield* PluginRuntime.Service
      const external = yield* ExternalAgentSession.Service
      const bus = yield* Bus.Service
      const config = yield* Config.Service
      const fs = yield* FSUtil.Service
      const permission = yield* Permission.Service
      const agents = yield* Agent.Service
      const tools = yield* Tool.Service
      const readiness = new Set<ExternalSession.Provider>()
      const refresh = Effect.gen(function* () {
        const configured = Config.latest(yield* config.entries(), "external_agents")
        const providers = yield* Effect.forEach(
          ExternalSession.Provider.literals,
          (provider) =>
            configured?.[provider]?.enabled === false
              ? Effect.succeed(undefined)
              : Effect.promise(() => platform.available(provider).catch(() => false)).pipe(
                  Effect.map((ready) => (ready ? provider : undefined)),
                ),
          { concurrency: 3 },
        )
        readiness.clear()
        providers.forEach((provider) => {
          if (provider !== undefined) readiness.add(provider)
        })
      })
      yield* refresh
      yield* ctx.event.subscribe().pipe(
        Stream.filter((event) => event.type === "config.updated"),
        Stream.debounce("100 millis"),
        Stream.runForEach(() => refresh.pipe(Effect.andThen(tools.reload()))),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* ctx.tool
        .transform((draft) => {
          for (const provider of readiness)
            draft.add({
              name: provider,
              input: Input,
              output: Output,
              options: { acceptsToolHandles: true },
              description: `Run ${provider} in an OC++ child session. Use it when the user explicitly requests this provider, preserve any requested model and effort, and never silently substitute another provider or model; report availability and authentication failures directly. Supply an absolute root plus an exact objective, relevant paths or context, constraints, and expected output in the message. For reviews, request prioritized concrete findings rather than a general endorsement. Verify factual findings before presenting them and clearly attribute them to the worker. Never poll the spawned worker for status or results: launch it once in a separate execute invocation, continue other independent work, and let its completion notification deliver the result. Pass sessionID only for real follow-up work after completion, never to check whether it is done. Private input, custom tool.define handles and outputSchema use the same machine-only contract as subagent.`,
              execute: (input, context) =>
                Effect.scoped(
                  Effect.gen(function* () {
                    if (!path.isAbsolute(input.root))
                      return yield* new ToolFailure({ message: "External agent directory must be absolute" })
                    const directory = AbsolutePath.make(yield* fs.resolve(input.root))
                    const source = { type: "tool" as const, messageID: context.messageID, id: context.id }
                    yield* permission.assert({
                      action: provider,
                      resources: [directory],
                      save: [directory],
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source,
                    })
                    yield* permission.assert({
                      action: "external_directory",
                      resources: [directory],
                      save: [directory],
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source,
                    })
                    if (!(yield* fs.isDir(directory)))
                      return yield* new ToolFailure({
                        message: "External agent directory does not exist: " + directory,
                      })
                    const parent = yield* runtime.session.get(context.sessionID)
                    let ancestor = parent
                    let depth = 0
                    while (ancestor.parentID) {
                      depth++
                      ancestor = yield* runtime.session.get(ancestor.parentID)
                    }
                    const entries = yield* config.entries()
                    const limit = Config.latest(entries, "experimental")?.subagent_depth ?? 1
                    if (depth >= limit)
                      return yield* new ToolFailure({ message: `Subagent depth limit reached (${limit})` })
                    const selected = Config.latest(entries, "external_agents")?.[provider]
                    const model = input.model ?? selected?.model ?? defaults[provider]
                    const effort = input.effort ?? selected?.effort
                    const selectedModel = {
                      providerID: Provider.ID.make(provider),
                      id: Model.ID.make(model),
                      variant: effort === undefined ? undefined : Model.VariantID.make(effort),
                    }
                    yield* permission.assert({
                      action: "model",
                      resources: [`${provider}/${model}`],
                      save: [],
                      sessionID: parent.id,
                      agent: context.agent,
                      source,
                    })
                    const existing =
                      input.sessionID === undefined ? undefined : yield* runtime.session.get(input.sessionID)
                    if (existing !== undefined && existing.parentID !== parent.id)
                      return yield* new ToolFailure({
                        message: "External session must be a child of the current session",
                      })
                    const candidate = existing === undefined ? undefined : yield* external.get(existing.id)
                    if (
                      existing !== undefined &&
                      (candidate === undefined || candidate.provider !== provider || candidate.directory !== directory)
                    )
                      return yield* new ToolFailure({
                        message: "External session provider and directory must match the original call",
                      })
                    const gateway = yield* ExternalAgentGateway.make(input)
                    yield* Effect.addFinalizer(() => Effect.sync(gateway.close))
                    const child =
                      existing ??
                      (yield* runtime.session.create({
                        parentID: parent.id,
                        location: { directory },
                        title: input.description,
                        agent: context.agent,
                        model: selectedModel,
                      }))
                    if (existing === undefined)
                      yield* bus.publish(ExternalSession.Bound, { sessionID: child.id, provider, directory })
                    yield* external.reserve(child.id)
                    const record = yield* external.get(child.id)
                    const stream = ExternalAgentStream.make(bus, child.id, context.agent, selectedModel, (event) =>
                      context
                        .progress({
                          sessionID: child.id,
                          status: "running",
                          phase: event.status,
                          ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
                        })
                        .pipe(Effect.orDie),
                    )
                    const history = canonicalHistory(
                      yield* runtime.session.messages({ sessionID: child.id, order: "asc" }),
                    )
                    if (
                      record?.historyHash !== undefined &&
                      record.historyHash !== Hash.sha256(JSON.stringify(history))
                    )
                      return yield* new ToolFailure({
                        message: "OC++ child history changed after its vendor checkpoint. Resume was refused.",
                      })
                    const message = [
                      input.message,
                      input.input === undefined
                        ? ""
                        : "Private machine input is available as input inside execute programs. Its contents are not included in this prompt.",
                      input.outputSchema === undefined
                        ? ""
                        : "You must finish by calling submit_result({ message, output }). Prefer execute programs so private input and structured output stay machine-only. Do not print private data.",
                    ]
                      .filter(Boolean)
                      .join("\n\n")
                    const sdk = yield* Effect.tryPromise({
                      try: () => platform.driver(provider),
                      catch: (error) => new ExternalAgentDriver.Error({ message: String(error) }),
                    })
                    const previous =
                      record?.vendorSessionID === undefined
                        ? undefined
                        : yield* Effect.tryPromise({
                            try: (signal) => sdk.inspect(directory, record.vendorSessionID!, signal),
                            catch: (error) => new ExternalAgentDriver.Error({ message: String(error) }),
                          })
                    if (previous !== undefined)
                      yield* Effect.try({
                        try: () => ExternalAgentDriver.check(record?.checkpoint, previous),
                        catch: (error) => new ExternalAgentDriver.Error({ message: String(error) }),
                      })
                    if (
                      child.model?.providerID !== provider ||
                      child.model.id !== model ||
                      child.model.variant !== effort
                    )
                      yield* bus.publish(SessionEvent.ModelSelected, { sessionID: child.id, model: selectedModel })
                    if (child.agent !== context.agent)
                      yield* bus.publish(SessionEvent.AgentSelected, { sessionID: child.id, agent: context.agent })
                    const checkpoint = { value: undefined as string | undefined }
                    const inboxID = SessionMessage.ID.create()
                    const run = Effect.gen(function* () {
                      yield* bus.publish(SessionEvent.InboxDelivered, { sessionID: child.id, inboxID })
                      yield* ExternalAgentDriver.execute(sdk, {
                        directory,
                        model,
                        effort,
                        history,
                        message,
                        gateway,
                        vendorSessionID: previous === undefined ? undefined : record?.vendorSessionID,
                        checkpoint: record?.checkpoint,
                        emit: (event) => Effect.runPromise(stream.emit(event).pipe(Effect.asVoid)),
                        linked: (vendorSessionID) =>
                          record?.vendorSessionID === vendorSessionID
                            ? Promise.resolve()
                            : Effect.runPromise(
                                bus
                                  .publish(ExternalSession.Linked, { sessionID: child.id, vendorSessionID })
                                  .pipe(Effect.asVoid),
                              ),
                        checkpointed: async (value) => {
                          checkpoint.value = value
                        },
                        authorize: (name, value, signal, toolID, cwd) =>
                          Effect.runPromise(
                            Effect.gen(function* () {
                              if (provider === "codex" && name === "workspace") {
                                const agent = yield* agents.resolve(context.agent)
                                for (const action of ["read", "edit", "shell"])
                                  yield* permission.assert({
                                    action,
                                    sessionID: parent.id,
                                    agent: context.agent,
                                    source,
                                    save: [],
                                    resources: [
                                      "*",
                                      ...(agent?.permissions ?? [])
                                        .filter(
                                          (rule) => Wildcard.match(action, rule.action) && rule.effect !== "allow",
                                        )
                                        .map((rule) => rule.resource),
                                    ],
                                    metadata: {
                                      provider,
                                      directory,
                                      delegation:
                                        "Codex native tools require authorization for their entire sandbox scope because its execution SDK has no per-tool approval callback.",
                                    },
                                  })
                              }
                              const nativeSource = stream.source(toolID)
                              const common = {
                                sessionID: nativeSource === undefined ? parent.id : child.id,
                                agent: context.agent,
                                source: nativeSource ?? source,
                                metadata: { provider, tool: name, directory },
                                save: [],
                              }
                              const selectedAction = action(provider, name)
                              const workingDirectory = cwd === undefined ? directory : yield* fs.resolve(cwd)
                              const command =
                                selectedAction !== "shell" || typeof value.command !== "string"
                                  ? undefined
                                  : yield* Effect.gen(function* () {
                                      const { ShellParse } = yield* Effect.promise(() => import("../../shell/parse.js"))
                                      return yield* ShellParse.scan(
                                        value.command as string,
                                        name === "powershell" ? "powershell" : "bash",
                                        workingDirectory,
                                        {
                                          portable:
                                            Config.latest(entries, "experimental")?.portable_shell_scanner === true,
                                        },
                                      )
                                    })
                              const file = value.file_path ?? value.path
                              const absolute =
                                typeof file === "string"
                                  ? yield* fs.resolve(LocationMutation.resolvePath(workingDirectory, file))
                                  : undefined
                              const paths = [
                                workingDirectory,
                                ...(absolute === undefined || FSUtil.contains(directory, absolute)
                                  ? []
                                  : [(yield* fs.isDir(absolute)) ? absolute : path.dirname(absolute)]),
                                ...(command?.directories ?? []),
                              ]
                              const externalPaths = yield* Effect.forEach(paths, (value) =>
                                fs.resolve(LocationMutation.resolvePath(workingDirectory, value)),
                              )
                              const outside = externalPaths.filter((value) => !FSUtil.contains(directory, value))
                              if (outside.length > 0)
                                yield* permission.assert({
                                  ...common,
                                  action: "external_directory",
                                  resources: outside.map((value) => path.join(value, "*").replaceAll("\\", "/")),
                                })
                              yield* permission.assert({
                                ...common,
                                action: selectedAction,
                                resources: command?.commands.length
                                  ? command.commands.map((item) => item.resource)
                                  : [
                                      absolute === undefined
                                        ? resource(directory, value)
                                        : (FSUtil.contains(directory, absolute)
                                            ? path.relative(directory, absolute) || "."
                                            : absolute
                                          ).replaceAll("\\", "/"),
                                    ],
                              })
                            }),
                            { signal },
                          ),
                      })
                      if (input.outputSchema !== undefined && gateway.result() === undefined)
                        return yield* new ExternalAgentDriver.Error({
                          message: "External agent did not submit the required structured result",
                        })
                    }).pipe(
                      Effect.onExit((exit) =>
                        Effect.gen(function* () {
                          yield* stream.finish(exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined)
                          if (Object.keys(stream.diagnostics()).length > 0)
                            yield* Effect.logDebug("External SDK diagnostics", {
                              sessionID: child.id,
                              provider,
                              events: stream.diagnostics(),
                            })
                          if (checkpoint.value === undefined) return
                          const messages = yield* runtime.session.messages({ sessionID: child.id, order: "asc" })
                          yield* bus.publish(ExternalSession.Checkpointed, {
                            sessionID: child.id,
                            checkpoint: checkpoint.value,
                            historyHash: Hash.sha256(JSON.stringify(canonicalHistory(messages))),
                          })
                        }),
                      ),
                      Effect.mapError((error) => new StepFailedError({ error: toSessionError(error) })),
                    )
                    yield* external.activate(child.id, run)
                    yield* bus.publish(SessionEvent.InboxEnqueued, {
                      sessionID: child.id,
                      inboxID,
                      item: { type: "user", delivery: "steer", payload: { text: message } },
                    })
                    yield* context.progress({ sessionID: child.id, status: "running" })
                    yield* runtime.session.resume(child.id).pipe(
                      Effect.onInterrupt(() => runtime.session.interrupt(child.id).pipe(Effect.ignore)),
                      Effect.mapError(
                        (error) =>
                          new ToolFailure({
                            message: `External agent failed (sessionID: ${child.id})`,
                            error,
                            metadata: { sessionID: child.id, status: "failed", provider },
                          }),
                      ),
                    )
                    const result = gateway.result() ?? {
                      message: stream.message() || "External agent completed without a text response.",
                      output: null,
                    }
                    return {
                      output: { sessionID: child.id, status: "completed" as const, ...result },
                      content: `<subagent sessionID="${child.id}" state="completed">\n${result.message}\n</subagent>`,
                      metadata: { sessionID: child.id, status: "completed", provider },
                    }
                  }),
                ).pipe(
                  Effect.mapError((error) =>
                    error instanceof ToolFailure
                      ? error
                      : new ToolFailure({ message: error instanceof Error ? error.message : String(error), error }),
                  ),
                ),
            })
        })
        .pipe(Effect.orDie)
    }),
  }
}
export const Plugin = make()

function action(provider: ExternalSession.Provider, name: string) {
  if (["Bash", "bash", "powershell", "command_execution"].includes(name)) return "shell"
  if (["Read", "read"].includes(name)) return "read"
  if (["Glob", "ls", "find"].includes(name)) return "glob"
  if (["Grep", "grep"].includes(name)) return "grep"
  if (["Edit", "Write", "NotebookEdit", "edit", "write", "file_change"].includes(name)) return "edit"
  if (name === "WebFetch") return "webfetch"
  if (name === "WebSearch") return "websearch"
  if (name === "Skill") return "skill"
  return `${provider}_${name}`
}
function resource(directory: string, value: Record<string, unknown>) {
  const file = value.file_path ?? value.path
  if (typeof file === "string") return LocationMutation.resolvePath(directory, file)
  if (typeof value.command === "string") return value.command
  if (typeof value.url === "string") return value.url
  return directory
}

function canonicalHistory(messages: ReadonlyArray<SessionMessage.Info>): ExternalAgentDriver.History[] {
  return messages.flatMap((message): ExternalAgentDriver.History[] => {
    if (message.type === "user" || message.type === "synthetic") return [{ role: "user", text: message.text }]
    if (message.type !== "assistant") return []
    return [
      {
        role: "assistant",
        text: message.content
          .map((part) => {
            if (part.type === "text" || part.type === "reasoning") return part.text
            return JSON.stringify(part)
          })
          .join("\n"),
      },
    ]
  })
}
