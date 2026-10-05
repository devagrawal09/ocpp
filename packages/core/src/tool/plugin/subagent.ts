export * as SubagentTool from "./subagent.js"

import { ToolFailure } from "@ocpp/ai"
import type { Context } from "@ocpp/plugin/effect/plugin"
import { ExternalSession } from "@ocpp/schema/external-session"
import { Model } from "@ocpp/schema/model"
import { Provider } from "@ocpp/schema/provider"
import { SessionDriver } from "@ocpp/schema/session-driver"
import { FSUtil } from "@ocpp/util/fs-util"
import { Deferred, Effect, Schema } from "effect"
import { realpath, stat } from "node:fs/promises"
import path from "path"
import { Agent } from "../../agent.js"
import { Bus } from "../../bus.js"
import { Catalog } from "../../catalog.js"
import { Config } from "../../config.js"
import { ExternalAgentDrivers } from "../../external-agent/drivers.js"
import { ExternalAgentEffort } from "../../external-agent/effort.js"
import { ExternalAgentModels } from "../../external-agent/models.js"
import { ExternalAgentSession } from "../../external-agent/session.js"
import { Location } from "../../location.js"
import { PluginRuntime } from "../../plugin/runtime.js"
import { SessionEvent } from "../../session/event.js"
import { AbsolutePath } from "../../schema.js"
import { SessionSchema } from "../../session/schema.js"
import { Tool } from "../../tool.js"
import { SubagentCustomTool } from "./subagent-custom.js"

export const name = "subagent"

const NO_TEXT = "Subagent completed without a text response."

const MAX_SUMMARY_KEYS = 20

const CONTINUE_AFTER_RESTART =
  "The server restarted while you were working on this task. Continue from where you left off without repeating completed work."

/** Progress a subagent call records once its child holds the task, so a restart can rejoin that child. */
const Attached = Schema.Struct({ sessionID: SessionSchema.ID })

type Submission = { readonly message: string; readonly output: typeof Schema.Json.Type }

export const Input = Schema.Struct({
  agent: Schema.String.annotate({
    description: "The agent preset to use: a prompt and model for the child. It grants no tools; pass them as tools",
  }),
  description: Schema.String.annotate({ description: "A short 3-5 word label for the task, displayed to the user" }),
  message: Schema.String.annotate({ description: "The task for the subagent to perform, shown to it in full" }),
  input: Schema.optionalKey(Schema.Json).annotate({
    description:
      "Machine data for the subagent. It is available directly as `input` in the subagent's Code Mode executions and is never rendered into either model's context. Pass existing notebook values by reference, for example { dataset }, and describe them in message.",
  }),
  inputSchema: Schema.optionalKey(SubagentCustomTool.JSONSchema).annotate({
    description: "JSON Schema that input must satisfy",
  }),
  model: Schema.optionalKey(Schema.String).annotate({
    description:
      "Model to use. For the ocpp driver, provider/model with an optional variant after #. For claude or codex, the vendor's own model name without a provider, with an optional effort after #, such as opus#high; an alias such as opus or sol always runs the vendor's newest model of that name. For pi, Pi's provider/model",
  }),
  driver: Schema.optionalKey(SessionDriver.ID).annotate({
    description:
      "What runs the child session: ocpp (the OC++ runner with a provider model), claude (Claude Code), codex (Codex) or pi (Pi). Defaults to the driver of the agent's configured model, else the calling session's; a continued session keeps its own",
  }),
  harness: Schema.optionalKey(SessionDriver.Harness).annotate({
    description:
      "Vendor drivers only. ocpp (default): the vendor's only tool is OC++ execute with this catalog, under the OC++ system prompt. native: the vendor's own tools and prompt, plus OC++ execute, tool.define handles and submit_result over MCP",
  }),
  outputSchema: Schema.optionalKey(SubagentCustomTool.JSONSchema).annotate({
    description:
      "JSON Schema for a required structured result. The subagent must finish with tools.submit_result({ message, output }).",
  }),
  tools: Schema.optionalKey(Schema.Array(Schema.Unknown)).annotate({
    description:
      "Exactly the tools the child may call: your own tools such as tools.read, whole namespaces such as tools.linear, and tool.define(...) handles. Omitted or empty, a new child has no tools (only submit_result with outputSchema); a continued child keeps the tools it had unless you pass new ones, less any you no longer have",
  }),
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({
    description:
      "Continue a specific previous subagent conversation by passing its sessionID. Calls without a sessionID start a new conversation.",
  }),
  root: Schema.optionalKey(Schema.String).annotate({
    description:
      "Existing absolute directory the child session runs in, such as a separate git worktree. The child runs under that directory's own config: its agents, models, MCP servers, plugins and instructions, and the tools you pass resolve there by the same paths. Defaults to the calling session's directory; a continued session keeps its own",
  }),
})

const ModelsOutput = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      variants: Schema.Array(Schema.String),
    }),
  ),
  drivers: Schema.Array(SessionDriver.Info),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literal("completed"),
  /** The subagent's final text, or the message it submitted with a structured result. */
  message: Schema.String,
  /** The submitted structured result, or null when no outputSchema was requested. */
  output: Schema.Json,
  /** Which tools a continued child lost because its caller no longer has them, and a newer version of its pinned vendor model. */
  notice: Schema.optionalKey(Schema.String),
})
export const description = [
  "Spawns an agent in a child session to work on the specified task.",
  "tools sets exactly what the child can call: pass your own tools such as tools.read, whole namespaces such as tools.linear, and tool.define handles, for example tools: [tools.read, tools.glob, tools.grep]. You can pass only tools you have. Without tools the child has none, only tools.submit_result when you pass outputSchema. The agent is a prompt and model preset and grants no tools.",
  "Call tools.subagent.models({}) to list the model IDs and variants currently available to subagents, and which vendor drivers are ready.",
  "driver picks what runs the child: ocpp (the OC++ runner with a provider model), claude (Claude Code), codex (Codex) or pi (Pi), each using the user's own login. A new child takes its agent's configured model's driver, else the calling session's; a continued session keeps its own. For claude or codex, model is the vendor's model name without a provider, with an optional effort after #, such as opus#high; an alias such as opus or sol always runs the vendor's newest model of that name. For pi it is Pi's provider/model.",
  'Vendor-driven children run in the OC++ harness by default: their only tool is execute over the tools you pass. Pass harness: "native" to give a claude, codex or pi child its own tools and prompt as well; OC++ execute over the tools you pass, tool.define handles and submit_result remain available to it over MCP.',
  "Use root to run a subagent in another existing directory, such as a separate git worktree, with any driver. The child runs under that directory's own config (agents, MCP servers, plugins, instructions), the agent must be defined there, and the tools you pass must exist there by the same paths. The child keeps that directory when continued.",
  "The output includes a sessionID you can pass back later to continue that specific conversation with the subagent.",
  "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
  "The subagent runs to completion and returns its final response as message. With outputSchema it must call tools.submit_result({ message, output }): message is returned in full, and output is returned only as machine data with a short summary in metadata.",
  "input is never shown to either model; it is available directly as `input` in the subagent's Code Mode executions. Pass existing notebook values by reference and describe them in message.",
  "Within Code Mode, subagent calls in one execution run serially. Use one separate execute invocation per subagent when they should run concurrently.",
  "Never poll a spawned subagent for status or results. Launch it once in a separate execute invocation, continue other independent work, and let its completion notification deliver the result. Use sessionID only for real follow-up work after completion, never to check whether it is done.",
  "tool.define(...) handles run in your own execution and can call only your tools.",
].join("\n")

export const Plugin = {
  id: "ocpp.tool.subagent",
  effect: Effect.fn("SubagentTool.Plugin")(function* (ctx: Context) {
    const runtime = yield* PluginRuntime.Service
    const agents = yield* Agent.Service
    const bus = yield* Bus.Service
    const catalog = yield* Catalog.Service
    const config = yield* Config.Service
    const tools = yield* Tool.Service
    const drivers = yield* ExternalAgentDrivers.Service
    const external = yield* ExternalAgentSession.Service
    const listModels = Effect.fn("SubagentTool.listModels")(function* () {
      return (yield* catalog.model.available()).map((model) => ({
        id: `${model.providerID}/${model.id}`,
        variants: model.variants.map((variant) => variant.id),
      }))
    })

    // Concatenate the child's final completed assistant text. Distinguishes "completed with no
    // text" (generic string) from "failed" (the run effect fails, surfaced as a job error).
    const latestAssistantText = Effect.fn("SubagentTool.latestAssistantText")(function* (sessionID: SessionSchema.ID) {
      const messages = yield* runtime.session.messages({ sessionID, order: "desc", limit: 20 })
      const assistant = messages.find(
        (message) =>
          message.type === "assistant" && message.time.completed !== undefined && message.error === undefined,
      )
      if (assistant === undefined || assistant.type !== "assistant") return NO_TEXT
      const text = assistant.content
        .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join("")
      return text.length > 0 ? text : NO_TEXT
    })

    yield* ctx.tool
      .transform((draft) => {
        draft.add({
          name: "models",
          options: { namespace: name, readOnly: true },
          description:
            "Lists model IDs and variants currently available to ocpp subagents, and the vendor drivers with their models.",
          input: Schema.Struct({}),
          output: ModelsOutput,
          execute: () =>
            Effect.all([listModels(), drivers.list()]).pipe(
              Effect.map(([models, vendors]) => ({
                output: { models, drivers: vendors },
                content: [
                  models.length === 0
                    ? "No subagent models are currently available."
                    : models
                        .map((model) =>
                          model.variants.length === 0
                            ? model.id
                            : `${model.id} (variants: ${model.variants.map((variant) => `#${variant}`).join(", ")})`,
                        )
                        .join("\n"),
                  ...listDrivers(vendors),
                ].join("\n"),
                metadata: { count: models.length },
              })),
            ),
        })
        draft.add({
          name,
          options: { acceptsToolHandles: true, reattach: true },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              // After a restart the call rejoins the child that already holds its task. Its checks
              // passed and its prompt was admitted before the restart, so none of that repeats.
              const reattached =
                context.recovered === undefined
                  ? undefined
                  : yield* Schema.decodeUnknownEffect(Attached)(context.recovered).pipe(
                      Effect.flatMap((attached) => runtime.session.get(attached.sessionID)),
                      Effect.mapError(
                        (error) => new ToolFailure({ message: "Subagent session to rejoin was not found", error }),
                      ),
                    )

              const parent = yield* runtime.session
                .get(context.sessionID)
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                  ),
                )
              let current = parent
              let depth = 0
              while (current.parentID) {
                depth++
                current = yield* runtime.session
                  .get(current.parentID)
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Parent session not found: ${current.parentID}`, error }),
                    ),
                  )
              }
              const limit = Config.latest(yield* config.entries(), "experimental")?.subagent_depth ?? 1
              if (depth >= limit)
                return yield* new ToolFailure({
                  message: `Subagent depth limit reached (${limit}). Increase "experimental.subagent_depth" to allow nested subagents.`,
                })
              // The call's own input is checked before any child exists.
              const given = yield* SubagentCustomTool.select(input.tools ?? [], context.catalog ?? new Map()).pipe(
                Effect.mapError((error) => new ToolFailure({ message: error.message, error })),
              )
              const outputCodec =
                input.outputSchema === undefined
                  ? undefined
                  : yield* SubagentCustomTool.validateSchema("structured result", input.outputSchema).pipe(
                      Effect.mapError((error) => new ToolFailure({ message: error.message, error })),
                    )
              if (input.inputSchema !== undefined) {
                const codec = yield* SubagentCustomTool.validateSchema(
                  "machine input",
                  input.inputSchema,
                  "inputSchema",
                ).pipe(Effect.mapError((error) => new ToolFailure({ message: error.message, error })))
                yield* Schema.decodeUnknownEffect(codec)(input.input).pipe(
                  Effect.mapError(
                    (error) =>
                      new ToolFailure({ message: `Subagent input does not match inputSchema: ${error.message}` }),
                  ),
                )
              }
              const existing =
                reattached ??
                (input.sessionID === undefined
                  ? undefined
                  : yield* runtime.session
                      .get(input.sessionID)
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new ToolFailure({ message: `Subagent session not found: ${input.sessionID}`, error }),
                        ),
                      ))
              if (existing !== undefined && existing.parentID !== context.sessionID)
                return yield* new ToolFailure({
                  message: `Session ${existing.id} is not a child of the current session`,
                })
              const location = yield* place(input.root, existing?.location ?? parent.location, existing !== undefined)
              const directory = location.directory

              // What the child is: its agent where it runs, its driver, harness and model.
              const agentAt = Effect.fnUntraced(function* () {
                const found = same(location, parent.location)
                  ? yield* agents.resolve(input.agent)
                  : (yield* runtime.location.agent.list(location)).data.find((item) => item.id === input.agent)
                if (found === undefined)
                  return yield* new ToolFailure({
                    message: same(location, parent.location)
                      ? `Unknown agent: ${input.agent}`
                      : `Unknown agent: ${input.agent} is not defined in ${directory}`,
                  })
                if (found.mode === "primary")
                  return yield* new ToolFailure({ message: `Agent ${input.agent} cannot run as a subagent` })
                return found
              })
              // What the call alone decides, so a mistake fails before any child exists.
              const precheck = Effect.fnUntraced(function* (driver: SessionDriver.ID | undefined) {
                if (input.harness === "native" && driver === "ocpp")
                  return yield* new ToolFailure({
                    message:
                      'harness "native" applies only to the claude, codex and pi drivers. The ocpp driver runs the OC++ runner.',
                  })
                if (driver === undefined || driver === "ocpp") return
                const reason = yield* drivers.unavailable(driver)
                if (reason !== undefined) return yield* new ToolFailure({ message: reason })
                const named = input.model?.split("#")[0]
                // Claude Code and Codex name models without a provider; Pi names them provider/model.
                if (named && (driver === "pi") !== named.includes("/"))
                  return yield* new ToolFailure({
                    message:
                      driver === "pi"
                        ? `Pi models are named provider/model, such as ${ExternalAgentDrivers.defaults.pi}: ${named}`
                        : `${SessionDriver.names[driver]} models are named without a provider, such as ${ExternalAgentDrivers.defaults[driver]}: ${named}. A provider/model ID runs on the ocpp driver.`,
                  })
              })
              const choose = Effect.fnUntraced(function* (agent: Agent.Info) {
                // Unless the call names one: a continued child keeps its own driver, and a new one takes its agent's
                // configured model's driver, else its caller's.
                const driver = input.driver ?? SessionDriver.of(existing?.model ?? agent.model ?? parent.model)
                yield* precheck(driver)
                const selected =
                  reattached !== undefined
                    ? undefined
                    : driver === "ocpp"
                      ? yield* runnerModel(agent)
                      : yield* vendorModel(driver, agent)
                return { agent, driver, harness: input.harness ?? "ocpp", selected }
              })
              // The model for an OC++-run child: requested, else a provider model its agent or caller already uses.
              const runnerModel = Effect.fnUntraced(function* (agent: Agent.Info) {
                const inherited = [
                  ...(existing === undefined || existing.agent !== agent.id ? [agent.model] : []),
                  ...(existing === undefined ? [parent.model] : []),
                ].find((model) => model !== undefined && SessionDriver.of(model) === "ocpp")
                const requested = input.model
                if (requested === undefined) {
                  if (existing === undefined || SessionDriver.of(existing.model) === "ocpp")
                    return { model: inherited, requested: false }
                  // A vendor child handed back to the runner needs a provider model.
                  const fallback =
                    inherited ??
                    (SessionDriver.of(parent.model) === "ocpp" ? parent.model : undefined) ??
                    (yield* catalog.model
                      .default()
                      .pipe(
                        Effect.map((model) =>
                          model === undefined
                            ? undefined
                            : Model.Ref.make({ providerID: model.providerID, id: model.id }),
                        ),
                      ))
                  if (fallback === undefined)
                    return yield* new ToolFailure({
                      message: "Pass model to choose a provider model for the ocpp driver.",
                    })
                  return { model: fallback, requested: false }
                }
                const availableModels = yield* listModels()
                const model = yield* Effect.try({
                  try: () => Model.Ref.parse(requested),
                  catch: (error) => unsupportedModel(requested, availableModels, error),
                })
                const available = availableModels.find((item) => item.id === `${model.providerID}/${model.id}`)
                if (
                  available === undefined ||
                  (model.variant !== undefined &&
                    model.variant !== "default" &&
                    !available.variants.includes(model.variant))
                )
                  return yield* unsupportedModel(requested, availableModels)
                return { model, requested: true }
              })
              // The model for a vendor-run child: requested as name#effort, else what the child, its agent or its
              // caller already uses with this vendor, else the vendor's configured default.
              const vendorModel = Effect.fnUntraced(function* (provider: ExternalSession.Provider, agent: Agent.Info) {
                const requested = input.model?.split("#")
                const current = (existing === undefined ? [agent.model, parent.model] : [existing.model]).find(
                  (model) => model !== undefined && SessionDriver.of(model) === provider,
                )
                const settings = yield* drivers.settings(provider)
                const id = requested?.[0] || (current?.id ?? settings.model)
                const inherited = current?.variant === "default" ? undefined : current?.variant
                const effort =
                  requested === undefined ? (inherited ?? settings.effort) : (requested[1] ?? settings.effort)
                if (
                  effort !== undefined &&
                  !(ExternalAgentEffort[provider].literals as ReadonlyArray<string>).includes(effort)
                )
                  return yield* new ToolFailure({
                    message: `Unsupported ${SessionDriver.names[provider]} effort: ${effort}. Use one of: ${ExternalAgentEffort[provider].literals.join(", ")}.`,
                  })
                // Read again at every call: an alias runs the vendor's newest model, and a pinned model is checked
                // for a newer one.
                const listed = yield* drivers.models(provider)
                const runs = listed.find((model) => model.id === ExternalAgentModels.resolve(id, listed))
                if (
                  effort !== undefined &&
                  runs !== undefined &&
                  runs.efforts.length > 0 &&
                  !runs.efforts.includes(effort)
                )
                  return yield* new ToolFailure({
                    message: `${runs.id === id ? id : `${id} (${runs.id})`} does not support effort ${effort}. Use one of: ${runs.efforts.join(", ")}.`,
                  })
                const upgrade = ExternalAgentModels.newer(id, listed)
                return {
                  model: Model.Ref.make({
                    providerID: Provider.ID.make(provider),
                    id: Model.ID.make(id),
                    ...(effort === undefined ? {} : { variant: Model.VariantID.make(effort) }),
                  }),
                  requested: true,
                  ...(upgrade === undefined
                    ? {}
                    : {
                        notice: [
                          `${SessionDriver.names[provider]} model ${id} has a newer version: ${upgrade.id}.`,
                          ...(upgrade.alias === undefined
                            ? []
                            : [`Pass model "${upgrade.alias}" to always run the newest ${upgrade.alias}.`]),
                          ...(upgrade.message === undefined ? [] : [upgrade.message]),
                        ].join(" "),
                      }),
                }
              })
              const chosen = yield* choose(yield* agentAt())
              const agent = chosen.agent
              const driver = chosen.driver
              const harness = chosen.harness
              const selected = chosen.selected?.model
              const upgrade =
                chosen.selected !== undefined && "notice" in chosen.selected ? chosen.selected.notice : undefined
              // A rooted child resolves the same tool paths in its own Location, which must provide every one.
              if (!same(location, parent.location)) {
                const there = yield* runtime.location.tool.paths(location)
                const missing = given.paths.filter((path) => !there.includes(path))
                if (missing.length > 0)
                  return yield* new ToolFailure({
                    message: `Subagent tools do not exist in ${directory}: ${missing.map((path) => "tools." + path).join(", ")}`,
                  })
              }
              if (reattached === undefined && existing !== undefined)
                yield* (
                  existing.agent === agent.id
                    ? Effect.void
                    : runtime.session.switchAgent({ sessionID: existing.id, agent: agent.id })
                ).pipe(
                  Effect.andThen(
                    selected === undefined
                      ? Effect.void
                      : runtime.session.switchModel({ sessionID: existing.id, model: selected }),
                  ),
                  Effect.mapError(
                    (error) =>
                      new ToolFailure({ message: `Failed to configure subagent session: ${existing.id}`, error }),
                  ),
                )

              const child =
                existing ??
                (yield* runtime.session
                  .create({
                    parentID: context.sessionID,
                    title: input.description,
                    agent: Agent.ID.make(input.agent),
                    model: selected,
                    // Otherwise the child inherits the caller's Location, workspace included.
                    ...(same(location, parent.location) ? {} : { location }),
                  })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                    ),
                  ))
              const vendor = SessionDriver.of(selected ?? existing?.model) !== "ocpp"
              // A new child gets exactly the tools the call passes, and none without them. A continued child keeps its
              // list unless the call passes a new one, less every tool its caller no longer has, such as after the
              // caller switched to plan mode, so a child never holds a tool its caller lacks.
              const continued = existing !== undefined && input.tools === undefined
              const lost =
                continued && reattached === undefined
                  ? (existing.tools ?? []).filter((path) => context.catalog?.get(path)?.lent !== false)
                  : []
              if (reattached === undefined && (!continued || lost.length > 0))
                yield* runtime.session
                  .selectTools({
                    sessionID: child.id,
                    tools: continued ? (existing.tools ?? []).filter((path) => !lost.includes(path)) : given.paths,
                  })
                  .pipe(
                    Effect.mapError(
                      (error) =>
                        new ToolFailure({ message: `Failed to give the subagent its tools: ${child.id}`, error }),
                    ),
                  )

              const submitted = outputCodec === undefined ? undefined : yield* Deferred.make<Submission>()
              // Resolves once the execution that carried a submission has committed its declarations,
              // so the child is stopped only after its notebook is durable. A submission made outside
              // Code Mode resolves it immediately: there is no execution to protect.
              const committed = outputCodec === undefined ? undefined : yield* Deferred.make<void>()
              let accepted = false
              let codeModeDepth = 0
              const machine = input.input
              const temporary: Tool.Info[] = [
                ...(outputCodec === undefined
                  ? []
                  : [
                      {
                        name: "submit_result",
                        description:
                          "Submit the final result. The message is shown to the caller in full; the output must match the requested schema and is returned to the caller only as machine data. The first valid submission ends this call.",
                        input: Schema.Struct({ message: Schema.String, output: outputCodec }),
                        options: { pinned: true },
                        execute: (value: { readonly message: string; readonly output: unknown }) =>
                          Effect.gen(function* () {
                            if (accepted) return yield* new Tool.Error({ message: "A result was already submitted" })
                            const output = yield* Schema.decodeUnknownEffect(Schema.Json)(value.output)
                            accepted = true
                            if (submitted !== undefined)
                              yield* Deferred.succeed(submitted, { message: value.message, output })
                            if (committed !== undefined && codeModeDepth === 0)
                              yield* Deferred.succeed(committed, undefined)
                            return { content: "Result submitted." }
                          }).pipe(
                            Effect.mapError((error) =>
                              error instanceof Tool.Error
                                ? error
                                : new Tool.Error({ message: "Submitted output is not valid JSON", error }),
                            ),
                          ),
                      } satisfies Tool.Info,
                    ]),
                ...given.lent,
              ]
              // Register immediately before the run whose `ensuring` owns cleanup, so no interruptible
              // step can leak the registration between acquiring it and attaching its disposal. Registrations
              // are shared by every Location, so a child placed elsewhere sees them too.
              const registration =
                temporary.length === 0 && machine === undefined
                  ? undefined
                  : yield* tools
                      .registerSession(child.id, temporary, machine === undefined ? undefined : { input: machine })
                      .pipe(
                        Effect.mapError(
                          (error) => new ToolFailure({ message: `Invalid subagent tool: ${error.message}`, error }),
                        ),
                      )
              const cleanup = registration?.dispose ?? Effect.void
              const resume = () =>
                runtime.session.resume(child.id).pipe(
                  Effect.as({ type: "idle" as const }),
                  Effect.onInterrupt(() => runtime.session.interrupt(child.id).pipe(Effect.ignore)),
                  Effect.mapError(
                    (error) =>
                      new ToolFailure({
                        message: `Subagent failed (sessionID: ${child.id})`,
                        error,
                        metadata: failure(child.id, "child-failed"),
                      }),
                  ),
                )
              // Hold the submission until the execution that produced it commits its declarations.
              // Only then does this branch win the race, so `resume` is interrupted — and the child
              // with it — after the execution is already terminal, which interruption cannot cancel.
              // The passive wait adds no model step.
              const completeSubmission = (result: Submission) =>
                (committed === undefined ? Effect.void : Deferred.await(committed)).pipe(
                  Effect.as({ type: "submitted" as const, ...result }),
                )
              const awaitSubmission = (pending: Deferred.Deferred<Submission>) =>
                Effect.raceFirst(resume(), Deferred.await(pending).pipe(Effect.flatMap(completeSubmission)))
              // A submission made from Code Mode ends this call only after that execution commits its
              // top-level declarations. Track running child executions so the terminal event that
              // follows the submission can release the wait.
              const observeCodeMode = (event: Bus.LogItem) => {
                if (!isCodeModeLifecycle(event) || event.data.sessionID !== child.id) return Effect.void
                if (event.type === SessionEvent.CodeMode.Started.type) {
                  codeModeDepth++
                  return Effect.void
                }
                codeModeDepth = Math.max(0, codeModeDepth - 1)
                return accepted && committed !== undefined
                  ? Deferred.succeed(committed, undefined).pipe(Effect.asVoid)
                  : Effect.void
              }
              const run = Effect.gen(function* () {
                const promptFailed = (error: unknown) =>
                  new ToolFailure({
                    message: `Failed to prompt subagent: ${child.id}`,
                    error,
                    metadata: failure(child.id, "prompt-failed"),
                  })
                // A rejoined child already holds its task, so it is only told to continue.
                yield* reattached === undefined
                  ? runtime.session
                      .prompt({
                        sessionID: child.id,
                        text: [
                          ...(existing === undefined ? ["You are a subagent spawned by another session."] : []),
                          ...(submitted === undefined
                            ? []
                            : [
                                "You must finish by calling tools.submit_result({ message, output }) with output matching the requested schema. The message is shown to the caller in full; the output is returned to it only as machine data. Do not return the final result as plain text.",
                              ]),
                          ...(machine === undefined
                            ? []
                            : [
                                `Machine input for this call is ${describe(machine)}. It is not shown here; use it directly as input in execute programs, for example input or input.dataset.`,
                              ]),
                          input.message,
                        ].join("\n"),
                        resume: false,
                      })
                      .pipe(Effect.mapError(promptFailed))
                  : runtime.session
                      .synthetic({
                        sessionID: child.id,
                        text: CONTINUE_AFTER_RESTART,
                        description: "Continuing after restart",
                        resume: false,
                      })
                      .pipe(Effect.mapError(promptFailed))
                // Recorded only once the child holds the task, so a restart before this point never
                // rejoins a child that has nothing to do.
                yield* context.progress({ sessionID: child.id, status: "running" })
                if (submitted === undefined) {
                  yield* resume()
                  const message = yield* latestAssistantText(child.id).pipe(
                    Effect.mapError(
                      (error) =>
                        new ToolFailure({
                          message: `Failed to read subagent output: ${child.id}`,
                          error,
                          metadata: failure(child.id, "output-unavailable"),
                        }),
                    ),
                  )
                  return { message, output: null }
                }
                const first = yield* awaitSubmission(submitted)
                if (first.type === "submitted") return { message: first.message, output: first.output }
                // The child went idle. A submission may still have been accepted from its final
                // execution just before it settled, so finish that rather than sending a needless
                // reminder that would cost another model step.
                if (accepted) {
                  const done = yield* Deferred.await(submitted).pipe(Effect.flatMap(completeSubmission))
                  // The child is already idle here; stop it so a late completion notification cannot
                  // wake a further model step.
                  yield* runtime.session.interrupt(child.id, { continue: false }).pipe(Effect.ignore)
                  return { message: done.message, output: done.output }
                }
                yield* runtime.session
                  .prompt({
                    sessionID: child.id,
                    text: "You did not submit the required result. Call tools.submit_result now with { message, output }, where output matches the requested schema.",
                    resume: false,
                  })
                  .pipe(
                    Effect.mapError(
                      (error) =>
                        new ToolFailure({
                          message: `Failed to remind subagent: ${child.id}`,
                          error,
                          metadata: failure(child.id, "reminder-failed"),
                        }),
                    ),
                  )
                const second = yield* awaitSubmission(submitted)
                if (second.type === "submitted") return { message: second.message, output: second.output }
                return yield* new ToolFailure({
                  message: `Subagent did not submit a structured result (sessionID: ${child.id})`,
                  metadata: failure(child.id, "no-submission"),
                })
              })
              const driven =
                submitted === undefined
                  ? run
                  : Effect.acquireUseRelease(
                      bus.listen(observeCodeMode),
                      () => run,
                      (unsubscribe) => unsubscribe,
                    )
              // A vendor child takes this call's harness and tools from its next drain on. A drain it is already
              // running on its own (a direct prompt, a late notification) finishes first, so this call starts a new one.
              const result = yield* Effect.scoped(
                (vendor
                  ? external.activate(child.id, { harness, tools: temporary }).pipe(
                      Effect.mapError((error) => new ToolFailure({ message: error.error.message, error })),
                      Effect.andThen(
                        runtime.session
                          .wait(child.id)
                          .pipe(
                            Effect.mapError(
                              (error) => new ToolFailure({ message: `Subagent session not found: ${child.id}`, error }),
                            ),
                          ),
                      ),
                    )
                  : Effect.void
                ).pipe(Effect.andThen(driven)),
              ).pipe(Effect.ensuring(cleanup))
              return {
                output: {
                  sessionID: child.id,
                  status: "completed" as const,
                  ...result,
                  ...(lost.length === 0 && upgrade === undefined
                    ? {}
                    : {
                        notice: [
                          ...(lost.length === 0
                            ? []
                            : [
                                `The subagent no longer has ${lost.map((path) => "tools." + path).join(", ")}: you no longer have ${lost.length === 1 ? "that tool" : "those tools"}, and a subagent keeps only tools its caller has.`,
                              ]),
                          ...(upgrade === undefined ? [] : [upgrade]),
                        ].join("\n"),
                      }),
                },
                structured: outputCodec !== undefined,
              }
            }).pipe(
              Effect.map((result) => ({
                output: result.output,
                // Only the message reaches the parent model; machine output stays in the
                // declared output, which a Code Mode assignment retains in full.
                content: `<subagent sessionID="${result.output.sessionID}" state="completed">\n${result.output.message}\n</subagent>${result.output.notice === undefined ? "" : "\n" + result.output.notice}`,
                metadata: {
                  sessionID: result.output.sessionID,
                  status: result.output.status,
                  ...(result.structured ? { output: summarize(result.output.output) } : {}),
                },
              })),
            ),
        })
      })
      .pipe(Effect.orDie)

    // The catalog lists only each description's first line, so SubagentInstructions shows the same
    // list up front; this copy is what tools.search returns.
    yield* ctx.tool.hook("catalog", (event) =>
      Effect.gen(function* () {
        const tool = event.tools[name]
        if (!tool || !event.agent) return
        const subagents = available(yield* agents.list())
        if (subagents.length === 0) return
        tool.description = [
          tool.description,
          "",
          "Available subagents:",
          ...listing(subagents),
          ...listDrivers(yield* drivers.list()),
        ].join("\n")
      }),
    )
  }),
}

/**
 * Where a child runs: `root`'s Location, or the Location it has (a continued child) or would inherit (a new one). A root
 * naming that same directory, through any spelling, keeps that Location, workspace included.
 */
const place = Effect.fnUntraced(function* (root: string | undefined, own: Location.Ref, continued: boolean) {
  if (root === undefined) return own
  if (!path.isAbsolute(root))
    return yield* new ToolFailure({ message: `Subagent root must be an absolute directory path: ${root}` })
  // A workspace directory exists only inside that workspace, so the local filesystem cannot place or compare it.
  if (own.workspaceID !== undefined) {
    if (path.resolve(root) === path.resolve(own.directory)) return own
    return yield* new ToolFailure({
      message: `Subagent root is not available in a workspace yet; a subagent runs in ${own.directory}: ${root}`,
    })
  }
  const resolved = yield* requireDirectory(root)
  if (resolved === (yield* requireDirectory(own.directory).pipe(Effect.orElseSucceed(() => own.directory)))) return own
  if (continued)
    return yield* new ToolFailure({
      message: `Subagent session runs in ${own.directory}. A continued session keeps its directory; omit root or pass that directory: ${root}`,
    })
  return Location.Ref.make({ directory: AbsolutePath.make(resolved) })
})

/** An existing directory's real path, with each way it can fail named. */
const requireDirectory = Effect.fnUntraced(function* (directory: string) {
  const resolved = yield* Effect.tryPromise({
    try: () => realpath(FSUtil.windowsPath(directory)),
    catch: (error) => new ToolFailure({ message: unresolved(error, directory), error }),
  })
  const info = yield* Effect.tryPromise({
    try: () => stat(resolved),
    catch: (error) => new ToolFailure({ message: unresolved(error, directory), error }),
  })
  if (!info.isDirectory()) return yield* new ToolFailure({ message: `Subagent root is not a directory: ${directory}` })
  return resolved
})

function unresolved(error: unknown, directory: string) {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
  if (code === "ENOENT") return `Subagent root does not exist: ${directory}`
  if (code === "ENOTDIR") return `Subagent root is not a directory: ${directory}`
  if (code === "ELOOP") return `Subagent root cannot be resolved: too many symbolic links: ${directory}`
  if (code === "EACCES" || code === "EPERM") return `Subagent root cannot be read: permission denied: ${directory}`
  return `Subagent root cannot be resolved: ${directory}`
}

function same(a: Location.Ref, b: Location.Ref) {
  return a.directory === b.directory && a.workspaceID === b.workspaceID
}

/** The drivers a model may choose, as it reads them: the ready vendor drivers, or nothing when none is ready. */
export function listDrivers(drivers: ReadonlyArray<SessionDriver.Info>) {
  const ready = drivers.filter((driver) => driver.available)
  if (ready.length === 0) return []
  return [
    "",
    "Drivers (the default is the agent's configured model's driver, else the calling session's):",
    "- ocpp: the OC++ runner with a provider model",
    ...ready.map(
      (driver) =>
        `- ${driver.id}: ${driver.name}, default model ${driver.model} (efforts: ${driver.variants.join(", ")})${
          driver.aliases === undefined
            ? ""
            : `; aliases run their newest models: ${Object.entries(driver.aliases)
                .map(([alias, model]) => `${alias} = ${model}`)
                .join(", ")}`
        }`,
    ),
  ]
}

/** The agents a caller may start as subagents: never primary or hidden agents. */
export function available(agents: ReadonlyArray<Agent.Info>) {
  return agents
    .filter((agent) => agent.mode !== "primary" && !agent.hidden)
    .toSorted((a, b) => a.id.localeCompare(b.id))
    .map((agent) => ({
      id: agent.id,
      description: agent.description ?? "This subagent should only be called when explicitly requested.",
    }))
}

export function listing(subagents: ReadonlyArray<{ readonly id: string; readonly description: string }>) {
  return subagents.map((agent) => `- ${agent.id}: ${agent.description}`)
}

/**
 * Metadata for a failure after the child exists. `reason` separates the child's own run failing,
 * the host failing to reach it, and a structured child that never submitted, so callers and
 * analytics never classify by message text.
 */
function failure(
  sessionID: SessionSchema.ID,
  reason: "child-failed" | "prompt-failed" | "reminder-failed" | "output-unavailable" | "no-submission",
) {
  return { sessionID, status: "error" as const, reason }
}

function unsupportedModel(
  requested: string,
  models: ReadonlyArray<{ readonly id: string; readonly variants: ReadonlyArray<string> }>,
  error?: unknown,
) {
  const base = requested.split("#")[0]
  const provider = base.split("/")[0]
  const id = base.split("/").slice(1).join("/")
  const candidates = requested.includes("#")
    ? models.flatMap((model) => [model.id, ...model.variants.map((variant) => `${model.id}#${variant}`)])
    : models.map((model) => model.id)
  const suggestions = candidates
    .map((candidate) => {
      const candidateBase = candidate.split("#")[0]
      const candidateID = candidateBase.split("/").slice(1).join("/")
      const length = Math.min(id.length, candidateID.length)
      return {
        candidate,
        rank:
          candidateBase === base
            ? 0
            : candidateBase.split("/")[0] === provider
              ? 1
              : candidateID === id
                ? 2
                : candidateID.includes(id) || id.includes(candidateID)
                  ? 3
                  : 4,
        prefix: Array.from({ length }, (_, index) => index).find((index) => id[index] !== candidateID[index]) ?? length,
      }
    })
    .toSorted(
      (a, b) =>
        a.rank - b.rank ||
        Number(b.candidate.includes("#")) - Number(a.candidate.includes("#")) ||
        b.prefix - a.prefix ||
        a.candidate.localeCompare(b.candidate),
    )
    .slice(0, 3)
    .map((item) => item.candidate)
  return new ToolFailure({
    message: [
      `Unsupported subagent model: ${requested}.`,
      ...(suggestions.length === 0 ? [] : [`Try one of: ${suggestions.join(", ")}.`]),
      "Query all available models with tools.subagent.models({}).",
    ].join(" "),
    ...(error === undefined ? {} : { error }),
  })
}

/** Narrows a log item to a child execution lifecycle event that carries a Session ID. */
function isCodeModeLifecycle(
  event: Bus.LogItem,
): event is SessionEvent.CodeMode.Started | SessionEvent.CodeMode.Completed | SessionEvent.CodeMode.Failed {
  return (
    event.type === SessionEvent.CodeMode.Started.type ||
    event.type === SessionEvent.CodeMode.Completed.type ||
    event.type === SessionEvent.CodeMode.Failed.type
  )
}

/** Shape and size of a machine value, never its contents, for model-visible metadata and prompts. */
function summarize(value: typeof Schema.Json.Type) {
  const bytes = new TextEncoder().encode(JSON.stringify(value) ?? "null").byteLength
  if (Array.isArray(value)) return { type: "array" as const, length: value.length, bytes }
  if (value !== null && typeof value === "object")
    return { type: "object" as const, keys: Object.keys(value).slice(0, MAX_SUMMARY_KEYS), bytes }
  if (value === null) return { type: "null" as const, bytes }
  return { type: typeof value, bytes }
}

/** One phrase naming the shape and size of a machine value, for guidance that must not show it. */
function describe(value: typeof Schema.Json.Type) {
  const summary = summarize(value)
  const keys = summary.type === "object" ? (summary.keys ?? []) : []
  const shape =
    summary.type === "object"
      ? keys.length === 0
        ? "an empty record"
        : `a record with keys ${keys.join(", ")}`
      : summary.type === "array"
        ? `an array of ${summary.length} items`
        : `a ${summary.type}`
  return `${shape} (${summary.bytes} bytes)`
}
