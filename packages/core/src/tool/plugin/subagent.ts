export * as SubagentTool from "./subagent.js"

import { ToolFailure } from "@opencode-ai/ai"
import type { Context } from "@opencode-ai/plugin/effect/plugin"
import { Model } from "@opencode-ai/schema/model"
import { Deferred, Effect, Schema } from "effect"
import { Agent } from "../../agent.js"
import { Bus } from "../../bus.js"
import { Config } from "../../config.js"
import { PluginRuntime } from "../../plugin/runtime.js"
import { Permission } from "../../permission.js"
import { SessionEvent } from "../../session/event.js"
import { SessionSchema } from "../../session/schema.js"
import { Tool } from "../../tool.js"
import { SubagentCustomTool } from "./subagent-custom.js"

export const name = "subagent"

const NO_TEXT = "Subagent completed without a text response."

export const Input = Schema.Struct({
  agent: Schema.String.annotate({ description: "The type of specialized agent to use for this task" }),
  description: Schema.String.annotate({ description: "A short 3-5 word label for the task, displayed to the user" }),
  prompt: Schema.String.annotate({ description: "The task for the subagent to perform" }),
  model: Schema.optionalKey(Schema.String).annotate({
    description: "Model to use, optionally including a variant after #",
  }),
  outputSchema: Schema.optionalKey(SubagentCustomTool.JSONSchema).annotate({
    description: "JSON Schema for a required structured result",
  }),
  tools: Schema.optionalKey(Schema.Array(SubagentCustomTool.Definition)).annotate({
    description: "Serializable Code Mode tools available only during this subagent call",
  }),
  sessionID: Schema.optionalKey(SessionSchema.ID).annotate({
    description:
      "Continue a specific previous subagent conversation by passing its sessionID. Calls without a sessionID start a new conversation.",
  }),
})

export const Output = Schema.Struct({
  sessionID: SessionSchema.ID,
  status: Schema.Literal("completed"),
  output: Schema.Json,
})
export const description = [
  "Spawns an agent in a child session to work on the specified task.",
  "The output includes a sessionID you can pass back later to continue that specific conversation with the subagent.",
  "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
  "The subagent runs to completion and returns its final response.",
  "Custom tools run with the parent session's Code Mode tools and permissions, not the child agent's restrictions.",
].join("\n")

export const Plugin = {
  id: "opencode.tool.subagent",
  effect: Effect.fn("SubagentTool.Plugin")(function* (ctx: Context) {
    const runtime = yield* PluginRuntime.Service
    const agents = yield* Agent.Service
    const bus = yield* Bus.Service
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const tools = yield* Tool.Service

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
      .transform((draft) =>
        draft.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input, context) =>
            Effect.gen(function* () {
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
              yield* SubagentCustomTool.validate(input.tools ?? []).pipe(
                Effect.mapError((error) => new ToolFailure({ message: error.message, error })),
              )
              if (input.outputSchema !== undefined)
                yield* SubagentCustomTool.validateSchema("structured result", input.outputSchema).pipe(
                  Effect.mapError((error) => new ToolFailure({ message: error.message, error })),
                )
              const selectedModel = input.model
              const requestedModel =
                selectedModel === undefined
                  ? undefined
                  : yield* Effect.try({
                      try: () => Model.Ref.parse(selectedModel),
                      catch: (error) => new ToolFailure({ message: `Invalid subagent model: ${selectedModel}`, error }),
                    })
              if (requestedModel !== undefined) {
                const resource = `${requestedModel.providerID}/${requestedModel.id}`
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

              const caller = yield* agents.resolve(context.agent)
              if (caller === undefined)
                return yield* new ToolFailure({ message: `Parent agent not found: ${context.agent}` })
              const parentTools = (yield* tools.registrations(caller.permissions, parent.id)).filter(
                (tool) => tool.options?.codemode !== false,
              )
              const submitted =
                input.outputSchema === undefined ? undefined : yield* Deferred.make<typeof Schema.Json.Type>()
              const pending = new Map<string, typeof Schema.Json.Type>()
              let accepted = false
              const temporary: Tool.Info[] = [
                ...(input.outputSchema === undefined
                  ? []
                  : [
                      {
                        name: "submit_result",
                        description: "Submit the final structured result. The first valid submission ends this call.",
                        input: input.outputSchema,
                        options: { pinned: true },
                        execute: (value: unknown, submitContext: Tool.Context) =>
                          Effect.gen(function* () {
                            if (accepted) return yield* new Tool.Error({ message: "A result was already submitted" })
                            const result = yield* Schema.decodeUnknownEffect(Schema.Json)(value)
                            accepted = true
                            pending.set(submitContext.id, result)
                            return { content: "Result submitted." }
                          }).pipe(
                            Effect.mapError((error) =>
                              error instanceof Tool.Error
                                ? error
                                : new Tool.Error({ message: "Submitted result is not valid JSON", error }),
                            ),
                          ),
                      } satisfies Tool.Info,
                    ]),
                ...SubagentCustomTool.make(input.tools ?? [], parentTools, context),
              ]
              const registration =
                temporary.length === 0
                  ? undefined
                  : yield* tools
                      .registerSession(child.id, temporary)
                      .pipe(
                        Effect.mapError(
                          (error) => new ToolFailure({ message: `Invalid subagent tool: ${error.message}`, error }),
                        ),
                      )
              const unsubscribe =
                submitted === undefined
                  ? undefined
                  : yield* bus.listen((event) => {
                      if (!isToolSuccess(event) || event.data.sessionID !== child.id) return Effect.void
                      const result = pending.get(event.data.id)
                      if (!pending.has(event.data.id) || result === undefined) return Effect.void
                      pending.delete(event.data.id)
                      return Deferred.succeed(submitted, result).pipe(Effect.asVoid)
                    })
              yield* context.progress({ sessionID: child.id, status: "running" })
              yield* runtime.session
                .prompt({
                  sessionID: child.id,
                  text:
                    existing === undefined
                      ? [
                          "You are a subagent spawned by another session.",
                          ...(submitted === undefined
                            ? []
                            : [
                                "You must finish by calling tools.submit_result with a value matching the requested schema. Do not return the final result as plain text.",
                              ]),
                          input.prompt,
                        ].join("\n")
                      : [
                          ...(submitted === undefined
                            ? []
                            : [
                                "You must finish by calling tools.submit_result with a value matching the requested schema. Do not return the final result as plain text.",
                              ]),
                          input.prompt,
                        ].join("\n"),
                  resume: false,
                })
                .pipe(
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Failed to prompt subagent: ${child.id}`, error }),
                  ),
                )

              const resume = () =>
                runtime.session.resume(child.id).pipe(
                  Effect.as({ type: "idle" as const }),
                  Effect.onInterrupt(() => runtime.session.interrupt(child.id).pipe(Effect.ignore)),
                  Effect.mapError(
                    (error) => new ToolFailure({ message: `Subagent failed (sessionID: ${child.id})`, error }),
                  ),
                )
              const run = Effect.gen(function* () {
                if (submitted === undefined) {
                  yield* resume()
                  return yield* latestAssistantText(child.id).pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Failed to read subagent output: ${child.id}`, error }),
                    ),
                  )
                }
                const first = yield* Effect.raceFirst(
                  resume(),
                  Deferred.await(submitted).pipe(Effect.map((output) => ({ type: "submitted" as const, output }))),
                )
                if (first.type === "submitted") return first.output
                yield* runtime.session
                  .prompt({
                    sessionID: child.id,
                    text: "You did not submit the required result. Call tools.submit_result now with a value matching the requested schema.",
                    resume: false,
                  })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: `Failed to remind subagent: ${child.id}`, error }),
                    ),
                  )
                const second = yield* Effect.raceFirst(
                  resume(),
                  Deferred.await(submitted).pipe(Effect.map((output) => ({ type: "submitted" as const, output }))),
                )
                if (second.type === "submitted") return second.output
                return yield* new ToolFailure({
                  message: `Subagent did not submit a structured result (sessionID: ${child.id})`,
                })
              })
              const output = yield* run.pipe(
                Effect.ensuring(
                  Effect.all([registration?.dispose ?? Effect.void, unsubscribe ?? Effect.void], { discard: true }),
                ),
              )
              return { sessionID: child.id, status: "completed" as const, output }
            }).pipe(
              Effect.map((output) => ({
                output,
                content: `<subagent sessionID="${output.sessionID}" state="completed">\n${render(output.output)}\n</subagent>`,
                metadata: { sessionID: output.sessionID, status: output.status },
              })),
            ),
        }),
      )
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

function render(value: typeof Schema.Json.Type) {
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2) ?? String(value)
}

function isToolSuccess(event: Bus.LogItem): event is SessionEvent.Tool.Success {
  return event.type === SessionEvent.Tool.Success.type
}
