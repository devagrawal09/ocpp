export * as SubagentTool from "./subagent.js"

import { ToolFailure } from "@ocpp/ai"
import type { Context } from "@ocpp/plugin/effect/plugin"
import { Model } from "@ocpp/schema/model"
import { Deferred, Effect, Schema } from "effect"
import { Agent } from "../../agent.js"
import { Bus } from "../../bus.js"
import { Catalog } from "../../catalog.js"
import { Config } from "../../config.js"
import { PluginRuntime } from "../../plugin/runtime.js"
import { Permission } from "../../permission.js"
import { SessionEvent } from "../../session/event.js"
import { SessionSchema } from "../../session/schema.js"
import { Tool } from "../../tool.js"
import { SubagentCustomTool } from "./subagent-custom.js"

export const name = "subagent"

const NO_TEXT = "Subagent completed without a text response."

const MAX_SUMMARY_KEYS = 20

type Submission = { readonly message: string; readonly output: typeof Schema.Json.Type }

export const Input = Schema.Struct({
  agent: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
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
    description: "Model to use, optionally including a variant after #",
  }),
  outputSchema: Schema.optionalKey(SubagentCustomTool.JSONSchema).annotate({
    description:
      "JSON Schema for a required structured result. The subagent must finish with tools.submit_result({ message, output }).",
  }),
  tools: Schema.optionalKey(Schema.Array(Schema.Unknown)).annotate({
    description: "Opaque tool.define(...) handles available only during this subagent call",
  }),
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({
    description:
      "Continue a specific previous subagent conversation by passing its sessionID. Calls without a sessionID start a new conversation.",
  }),
})

const ModelsOutput = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      variants: Schema.Array(Schema.String),
    }),
  ),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literal("completed"),
  /** The subagent's final text, or the message it submitted with a structured result. */
  message: Schema.String,
  /** The submitted structured result, or null when no outputSchema was requested. */
  output: Schema.Json,
})
export const description = [
  "Spawns an agent in a child session to work on the specified task.",
  "Call tools.subagent.models({}) to list the model IDs and variants currently available to subagents.",
  "The output includes a sessionID you can pass back later to continue that specific conversation with the subagent.",
  "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
  "The subagent runs to completion and returns its final response as message. With outputSchema it must call tools.submit_result({ message, output }): message is returned in full, and output is returned only as machine data with a short summary in metadata.",
  "input is never shown to either model; it is available directly as `input` in the subagent's Code Mode executions. Pass existing notebook values by reference and describe them in message.",
  "Within Code Mode, subagent calls in one execution run serially. Use one separate execute invocation per subagent when they should run concurrently.",
  "Never poll a spawned subagent for status or results. Launch it once in a separate execute invocation, continue other independent work, and let its completion notification deliver the result. Use sessionID only for real follow-up work after completion, never to check whether it is done.",
  "tool.define(...) handles retain only compiler-derived capabilities allowed by the parent activation.",
].join("\n")

export const Plugin = {
  id: "ocpp.tool.subagent",
  effect: Effect.fn("SubagentTool.Plugin")(function* (ctx: Context) {
    const runtime = yield* PluginRuntime.Service
    const agents = yield* Agent.Service
    const bus = yield* Bus.Service
    const catalog = yield* Catalog.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const tools = yield* Tool.Service
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
          options: { namespace: name },
          description: "Lists model IDs and variants currently available to subagents.",
          input: Schema.Struct({}),
          output: ModelsOutput,
          execute: () =>
            listModels().pipe(
              Effect.map((models) => ({
                output: { models },
                content:
                  models.length === 0
                    ? "No subagent models are currently available."
                    : models
                        .map((model) =>
                          model.variants.length === 0
                            ? model.id
                            : `${model.id} (variants: ${model.variants.map((variant) => `#${variant}`).join(", ")})`,
                        )
                        .join("\n"),
                metadata: { count: models.length },
              })),
            ),
        })
        draft.add({
          name,
          options: { acceptsToolHandles: true },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
              const availableModels = input.model === undefined ? [] : yield* listModels()

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
              const agent = yield* agents.resolve(input.agent)
              if (agent === undefined) return yield* new ToolFailure({ message: `Unknown agent: ${input.agent}` })
              if (agent.mode === "primary")
                return yield* new ToolFailure({ message: `Agent ${input.agent} cannot run as a subagent` })
              yield* permission
                .assert({
                  action: name,
                  resources: [agent.id],
                  save: [agent.id],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: {
                    type: "tool",
                    messageID: context.messageID,
                    id: context.id,
                  },
                })
                .pipe(Effect.mapError((error) => new ToolFailure({ message: `Subagent denied: ${agent.id}`, error })))
              const customTools = yield* SubagentCustomTool.validate(input.tools ?? []).pipe(
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
              const selectedModel = input.model
              const requestedModel =
                selectedModel === undefined
                  ? undefined
                  : yield* Effect.try({
                      try: () => Model.Ref.parse(selectedModel),
                      catch: (error) => unsupportedModel(selectedModel, availableModels, error),
                    })
              if (requestedModel !== undefined && selectedModel !== undefined) {
                const resource = `${requestedModel.providerID}/${requestedModel.id}`
                const available = availableModels.find((model) => model.id === resource)
                if (
                  available === undefined ||
                  (requestedModel.variant !== undefined &&
                    requestedModel.variant !== "default" &&
                    !available.variants.includes(requestedModel.variant))
                )
                  return yield* unsupportedModel(selectedModel, availableModels)
                const allowed = Config.latest(yield* config.entries(), "subagent")?.models?.includes(resource) === true
                if (!allowed)
                  yield* permission
                    .assert({
                      action: "subagent_model",
                      resources: [resource],
                      save: [],
                      sessionID: context.sessionID,
                      agent: context.agent,
                      source: { type: "tool", messageID: context.messageID, id: context.id },
                    })
                    .pipe(
                      Effect.mapError(
                        (error) => new ToolFailure({ message: `Subagent model denied: ${selectedModel}`, error }),
                      ),
                    )
              }

              const existing =
                input.sessionID === undefined
                  ? undefined
                  : yield* runtime.session
                      .get(input.sessionID)
                      .pipe(
                        Effect.mapError(
                          (error) =>
                            new ToolFailure({ message: `Subagent session not found: ${input.sessionID}`, error }),
                        ),
                      )
              if (existing !== undefined && existing.parentID !== context.sessionID)
                return yield* new ToolFailure({
                  message: `Session ${existing.id} is not a child of the current session`,
                })
              if (existing !== undefined && (existing.agent !== agent.id || requestedModel !== undefined)) {
                const model = requestedModel ?? (existing.agent !== agent.id ? agent.model : undefined)
                yield* (
                  existing.agent === agent.id
                    ? Effect.void
                    : runtime.session.switchAgent({ sessionID: existing.id, agent: agent.id })
                ).pipe(
                  Effect.andThen(
                    model === undefined ? Effect.void : runtime.session.switchModel({ sessionID: existing.id, model }),
                  ),
                  Effect.mapError(
                    (error) =>
                      new ToolFailure({ message: `Failed to configure subagent session: ${existing.id}`, error }),
                  ),
                )
              }

              const model = requestedModel ?? agent.model ?? parent.model
              const child =
                existing ??
                (yield* runtime.session
                  .create({
                    parentID: context.sessionID,
                    title: input.description,
                    agent: Agent.ID.make(input.agent),
                    model,
                  })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Parent session not found: ${context.sessionID}`, error }),
                    ),
                  ))

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
                ...SubagentCustomTool.make(customTools),
              ]
              yield* context.progress({ sessionID: child.id, status: "running" })
              // Register immediately before the run whose `ensuring` owns cleanup, so no interruptible
              // step can leak the registration between acquiring it and attaching its disposal.
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
                yield* runtime.session
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
                  .pipe(
                    Effect.mapError(
                      (error) =>
                        new ToolFailure({
                          message: `Failed to prompt subagent: ${child.id}`,
                          error,
                          metadata: failure(child.id, "prompt-failed"),
                        }),
                    ),
                  )
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
              const result = yield* driven.pipe(Effect.ensuring(cleanup))
              return {
                output: { sessionID: child.id, status: "completed" as const, ...result },
                structured: outputCodec !== undefined,
              }
            }).pipe(
              Effect.map((result) => ({
                output: result.output,
                // Only the message reaches the parent model; machine output stays in the
                // declared output, which a Code Mode assignment retains in full.
                content: `<subagent sessionID="${result.output.sessionID}" state="completed">\n${result.output.message}\n</subagent>`,
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

    yield* ctx.session.hook("context", (event) =>
      Effect.gen(function* () {
        const tool = event.tools[name]
        if (!tool) return
        const selected = yield* agents.resolve(event.agent)
        if (!selected) return
        const available = (yield* agents.list())
          .filter(
            (agent) =>
              agent.mode !== "primary" &&
              !agent.hidden &&
              Permission.evaluate(name, agent.id, selected.permissions).effect !== "deny",
          )
          .toSorted((a, b) => a.id.localeCompare(b.id))
        if (available.length === 0) return
        tool.description = [
          tool.description,
          "",
          "Available subagents:",
          ...available.map(
            (agent) =>
              `- ${agent.id}: ${agent.description ?? "This subagent should only be called when explicitly requested."}`,
          ),
        ].join("\n")
      }),
    )
  }),
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
