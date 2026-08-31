export * as CodeModeTool from "./tool.js"

import { CodeMode, Tool, toolError } from "@opencode-ai/codemode"
import { CodeModeExecution } from "@opencode-ai/schema/codemode-execution"
import { ascending } from "@opencode-ai/schema/identifier"
import { Error, type Context, type Info, type Metadata, type Result } from "@opencode-ai/schema/tool"
import { Deferred, Effect, Ref, Schema, Scope, Semaphore } from "effect"
import type { Bus } from "../bus.js"
import type { Job } from "../job.js"
import type { Session } from "../session.js"
import { SessionEvent } from "../session/event.js"
import { CodeModeCompletion } from "../session/codemode-completion.js"
import { SessionMessage } from "../session/message.js"
import { definition, normalizedName } from "../tool/runtime.js"

type ExecuteCall = CodeModeExecution.ToolEvent
type ExecuteEvent = CodeModeExecution.Entry

const ExecuteInput = Schema.Struct({
  code: Schema.String,
  timeoutMs: Schema.optionalKey(
    Schema.UndefinedOr(Schema.Int.check(Schema.isGreaterThan(0))).annotate({
      description: "Optional wall-clock execution limit in milliseconds",
    }),
  ),
})

const ExecuteOutput = Schema.Struct({
  executionID: CodeModeExecution.ID,
  status: Schema.Literal("running"),
})

const decodeExecuteEvents = Schema.decodeUnknownSync(CodeModeExecution.Entries)
const decodeExecutionID = Schema.decodeUnknownSync(CodeModeExecution.ID)
const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_TRACE_EVENTS = 100
const MAX_TOOL_EVENTS = 100
const MAX_TOOL_EVENT_BYTES = 4 * 1024
const MAX_CONCURRENT_EXECUTIONS = 4

type ExecutionServices = {
  readonly bus: Pick<Bus.Interface, "publish" | "listen">
  readonly jobs: Pick<
    Job.Interface,
    "startLimited" | "wait" | "background" | "cancel" | "markBackgroundTerminal" | "completeBackground"
  >
  readonly sessions: Pick<Session.Interface, "message" | "synthetic">
  readonly scope: Scope.Scope
}

// Invariant model-facing guidance; the changing tool catalog is delivered through Instructions.
const description = [
  "Run JavaScript in a confined Code Mode runtime to orchestrate tool calls and compose their results.",
  "Imports, direct filesystem access, and timers are unavailable. Do not use `fetch`; all external access goes through `tools`.",
  "Within `{ code }`, the only callable tools are those explicitly listed in the Code Mode catalog instructions or returned by `search`. Inside `{ code }`, ignore tools shown outside the Code Mode catalog. They are not available in the Code Mode runtime.",
  'Call tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.<namespace>["tool-name"](input)`.',
  "Prefer an explicit `return`; if omitted, the final top-level expression becomes the result.",
  "Await every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.all`.",
  "Execute returns an execution ID immediately. Results and bounded logs arrive later as a Session message.",
].join("\n")

export const create = (
  registrations: ReadonlyMap<string, Info>,
  executeTool: (name: string, tool: Info, input: unknown, context: Context) => Effect.Effect<Result, Error>,
  services: ExecutionServices,
) => {
  return {
    name: "execute",
    description,
    input: ExecuteInput,
    output: ExecuteOutput,
    execute: ({ code, timeoutMs }, context) =>
      Effect.gen(function* () {
        const events = yield* Ref.make<Array<ExecuteEvent>>([])
        const slots = yield* Ref.make<Array<number>>([])
        const toolCount = yield* Ref.make(0)
        const traceCount = yield* Ref.make(0)
        const gate = yield* Deferred.make<void>()
        const lock = Semaphore.makeUnsafe(1)
        const executionID = "exe_" + ascending()
        const eventExecutionID = decodeExecutionID(executionID)
        const notificationID = SessionMessage.ID.create()
        const publish = (next: Array<ExecuteEvent>) =>
          services.bus.publish(SessionEvent.CodeMode.Progress, {
            sessionID: context.sessionID,
            assistantMessageID: context.messageID,
            id: context.id,
            executionID: eventExecutionID,
            events: decodeExecuteEvents(next),
          })
        const appendTool = (index: number, event: ExecuteCall) =>
          lock.withPermit(
            Effect.gen(function* () {
              const count = yield* Ref.getAndUpdate(toolCount, (count) => count + 1)
              if (count >= MAX_TOOL_EVENTS) return
              const items = yield* Ref.get(events)
              yield* Ref.update(slots, (current) => {
                const next = [...current]
                next[index] = items.length
                return next
              })
              const next = [...items, event]
              yield* Ref.set(events, next)
              yield* publish(next)
            }),
          )
        const appendTrace = (event: CodeMode.TraceEvent) =>
          Effect.flatMap(
            Ref.getAndUpdate(traceCount, (count) => count + 1),
            (count) =>
              count >= MAX_TRACE_EVENTS
                ? Effect.void
                : lock.withPermit(
                    Ref.updateAndGet(events, (items) => [...items, executeTrace(event)]).pipe(Effect.flatMap(publish)),
                  ),
          )
        const updateTool = (index: number, update: (event: ExecuteCall) => ExecuteCall) =>
          lock.withPermit(
            Effect.gen(function* () {
              const slot = (yield* Ref.get(slots))[index]
              if (slot === undefined) return
              const items = yield* Ref.get(events)
              const current = items[slot]
              if (!current || current.type !== "tool") return
              const updated = update(current)
              if (updated === current) return
              const next = [...items]
              next[slot] = updated
              yield* Ref.set(events, next)
              yield* publish(next)
            }),
          )
        const run = Effect.gen(function* () {
          const result = yield* runtime(
            registrations,
            (name, tool, input, index) =>
              Effect.gen(function* () {
                const executed = yield* executeTool(name, tool, input, {
                  ...context,
                  progress: (metadata) => {
                    const shown = displayMetadata(metadata)
                    return updateTool(index, (current) => ({ ...current, ...(shown ? { metadata: shown } : {}) }))
                  },
                }).pipe(
                  Effect.tapError((error) => {
                    const shown = displayMetadata(error.metadata)
                    return updateTool(index, (current) => ({
                      ...current,
                      status: "error",
                      error: boundToolEventText(error.message),
                      ...(shown ? { metadata: shown } : {}),
                    }))
                  }),
                )
                const content =
                  typeof executed.content === "string"
                    ? [{ type: "text" as const, text: executed.content }]
                    : (executed.content ?? [])
                const text = content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")
                const metadata = displayMetadata(executed.metadata)
                yield* updateTool(index, (current) => ({
                  ...current,
                  status: "completed",
                  ...(text ? { output: boundToolEventText(text) } : {}),
                  ...(metadata ? { metadata } : {}),
                }))
                if (executed.output !== undefined) return executed.output
                return text === "" ? null : text
              }),
            {
              onToolCallStart: ({ index, name, input }) => {
                const shown = displayInput(input)
                return appendTool(index, {
                  type: "tool",
                  tool: boundToolEventText(name),
                  status: "running",
                  ...(shown ? { input: shown } : {}),
                })
              },
              onToolCallEnd: ({ index, outcome, output, message }) =>
                updateTool(index, (current) =>
                  outcome === "success"
                    ? current.status === "completed"
                      ? current
                      : {
                          ...current,
                          status: "completed",
                          ...(current.output !== undefined ? {} : { output: displayOutput(output) }),
                        }
                    : {
                        ...current,
                        status: "error",
                        ...(current.error
                          ? {}
                          : { error: boundToolEventText(message ?? "Tool execution interrupted") }),
                      },
                ),
              onTrace: appendTrace,
            },
            { timeoutMs, maxOutputBytes: MAX_OUTPUT_BYTES },
          ).execute(code)
          const output = formatResult(result)
          if (!result.ok) return yield* Effect.fail(new Error({ message: output }))
          return output
        })
        const recovery = {
          kind: "codemode" as const,
          parentSessionID: context.sessionID,
          assistantMessageID: context.messageID,
          toolCallID: context.id,
          code,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        }
        const job = yield* services.jobs.startLimited({
          id: executionID,
          type: "codemode",
          ownerSessionID: context.sessionID,
          maxConcurrent: MAX_CONCURRENT_EXECUTIONS,
          notificationID,
          recovery,
          run: Deferred.await(gate).pipe(Effect.andThen(run)),
        })
        if (!job)
          return yield* new Error({
            message: `Code Mode allows at most ${MAX_CONCURRENT_EXECUTIONS} concurrent executions per Session.`,
          })
        yield* services.jobs.background(executionID)
        yield* services.bus.publish(SessionEvent.CodeMode.Started, {
          sessionID: context.sessionID,
          assistantMessageID: context.messageID,
          id: context.id,
          executionID: eventExecutionID,
          code,
          timeoutMs,
        })
        const unsubscribe = yield* services.bus.listen((event) => {
          if (!isToolSettlement(event)) return Effect.void
          if (event.data.assistantMessageID !== context.messageID || event.data.id !== context.id) return Effect.void
          return event.type === SessionEvent.Tool.Success.type
            ? Deferred.succeed(gate, undefined)
            : services.jobs.cancel(executionID).pipe(Effect.asVoid)
        })
        yield* Scope.addFinalizer(services.scope, unsubscribe)
        yield* services.jobs.wait({ id: executionID }).pipe(
          Effect.tap(() => unsubscribe),
          Effect.flatMap((result) => {
            const info = result.info
            if (!info || info.status === "running") return Effect.void
            return Effect.gen(function* () {
              const trace = decodeExecuteEvents(yield* Ref.get(events))
              const base = {
                sessionID: context.sessionID,
                assistantMessageID: context.messageID,
                id: context.id,
                executionID: eventExecutionID,
                events: trace,
              }
              if (info.status === "completed")
                yield* services.bus.publish(
                  SessionEvent.CodeMode.Completed,
                  { ...base, output: info.output ?? "" },
                  { commit: () => services.jobs.markBackgroundTerminal(notificationID) },
                )
              if (info.status === "error" || info.status === "cancelled")
                yield* services.bus.publish(
                  SessionEvent.CodeMode.Failed,
                  {
                    ...base,
                    status: info.status,
                    error: info.error ?? (info.status === "cancelled" ? "Execution cancelled" : "Execution failed"),
                  },
                  { commit: () => services.jobs.markBackgroundTerminal(notificationID) },
                )
              yield* CodeModeCompletion.deliver(services.sessions, services.jobs, {
                ...info,
                recovery,
              })
            })
          }),
          Effect.forkIn(services.scope, { startImmediately: true }),
        )
        return {
          output: { executionID: eventExecutionID, status: "running" as const },
          content: [{ type: "text" as const, text: `Code Mode execution ${job.id} started.` }],
          metadata: { executionID: eventExecutionID, executionStatus: "running", events: [] },
        }
      }),
  } satisfies Info
}
export const catalog = (registrations: ReadonlyMap<string, Info>) => {
  const pinned = new Set(
    Array.from(registrations.values())
      .filter((registration) => registration.options?.pinned === true)
      .map(qualifiedName),
  )
  return runtime(registrations, () => Effect.fail(toolError("Execute context is unavailable")))
    .catalog()
    .map((entry) => ({ ...entry, pinned: pinned.has(entry.path) }))
}

function runtime(
  registrations: ReadonlyMap<string, Info>,
  executeTool: (name: string, tool: Info, input: unknown, index: number) => Effect.Effect<unknown, unknown>,
  hooks?: CodeMode.ToolCallHooks & { readonly onTrace?: CodeMode.TraceHook },
  limits?: CodeMode.ExecutionLimits,
) {
  const tools: Record<string, Tool.Tool<never>> = {}
  for (const [name, registration] of registrations) {
    const child = definition(registration)
    const path = qualifiedName(registration)
    tools[path] = Tool.make({
      description: child.description,
      input: child.inputSchema,
      output: child.outputSchema ?? Schema.NullOr(Schema.String),
      execute: (input, call) =>
        call
          ? executeTool(name, registration, input, call.index)
          : Effect.fail(toolError("Code Mode tool context is unavailable")),
    })
  }
  return CodeMode.make<typeof tools>({ tools, ...hooks, limits })
}

function isToolSettlement(event: Bus.LogItem): event is SessionEvent.Tool.Success | SessionEvent.Tool.Failed {
  return event.type === SessionEvent.Tool.Success.type || event.type === SessionEvent.Tool.Failed.type
}

function qualifiedName(registration: Info) {
  const normalized = normalizedName(registration)
  if (registration.options?.namespace === undefined) return normalized
  return `${registration.options.namespace}.${normalized}`
}

// Tool inputs arrive as parsed JSON, so the JSON value cast is a boundary fact.
function displayInput(input: unknown): Record<string, typeof Schema.Json.Type> | undefined {
  if (input === null || input === undefined) return
  if (typeof input !== "object" || Array.isArray(input))
    return boundToolEventRecord({ input: input as typeof Schema.Json.Type })
  if (Object.keys(input).length === 0) return
  return boundToolEventRecord(input as Record<string, typeof Schema.Json.Type>)
}

const isJsonMetadata = Schema.is(Schema.Record(Schema.String, Schema.Json))

function displayMetadata(metadata: Metadata | undefined) {
  return isJsonMetadata(metadata) ? boundToolEventRecord(metadata) : undefined
}

function boundToolEventRecord(value: Record<string, typeof Schema.Json.Type>) {
  const encoded = JSON.stringify(value)
  if (new TextEncoder().encode(encoded).length <= MAX_TOOL_EVENT_BYTES) return value
  return truncatedToolEventRecord(encoded, MAX_TOOL_EVENT_BYTES - 32)
}

function truncatedToolEventRecord(value: string, maxBytes: number): Record<string, typeof Schema.Json.Type> {
  const result = { truncated: boundToolEventText(value, maxBytes) }
  if (new TextEncoder().encode(JSON.stringify(result)).length <= MAX_TOOL_EVENT_BYTES) return result
  return truncatedToolEventRecord(value, Math.floor(maxBytes / 2))
}

function boundToolEventText(value: string, maxBytes = MAX_TOOL_EVENT_BYTES): string {
  if (maxBytes <= 3) return ""
  const bytes = new TextEncoder().encode(value)
  const candidate = bytes.length <= maxBytes ? value : decodeToolEventText(bytes, maxBytes - 3) + "..."
  if (new TextEncoder().encode(JSON.stringify(candidate)).length <= MAX_TOOL_EVENT_BYTES) return candidate
  return boundToolEventText(value, Math.floor(maxBytes / 2))
}

function decodeToolEventText(value: Uint8Array, end: number) {
  const decoded = new TextDecoder().decode(value.slice(0, end))
  return decoded.endsWith("\uFFFD") ? decoded.slice(0, -1) : decoded
}

function executeTrace(event: CodeMode.TraceEvent): ExecuteEvent {
  switch (event.kind) {
    case "assignment":
      return {
        type: "trace",
        kind: event.kind,
        target: boundToolEventText(event.target),
        value: boundToolEventText(event.value),
      }
    case "branch":
      return { type: "trace", kind: event.kind, expression: boundToolEventText(event.expression), result: event.result }
    case "operation":
      return {
        type: "trace",
        kind: event.kind,
        operation: boundToolEventText(event.operation),
        input: boundToolEventText(event.input),
        output: boundToolEventText(event.output),
      }
    case "log":
      return {
        type: "trace",
        kind: event.kind,
        method: boundToolEventText(event.method),
        message: boundToolEventText(event.message),
      }
    case "return":
      return { type: "trace", kind: event.kind, value: boundToolEventText(event.value) }
  }
}

function displayOutput(output: unknown) {
  if (output === undefined) return
  if (typeof output === "string") return boundToolEventText(output)
  return boundToolEventText(JSON.stringify(output, null, 2) ?? String(output))
}

function formatResult(result: CodeMode.Result) {
  const output = result.ok
    ? formatValue(result.value)
    : [result.error.message, ...(result.error.suggestions ?? []).filter((hint) => !result.error.message.includes(hint))]
        .join("\n")
        .trim()
  const warnings =
    result.ok && result.warnings && result.warnings.length > 0
      ? `Warnings:\n${result.warnings.map((item) => `- [${item.kind}] ${item.message}`).join("\n")}`
      : undefined
  const logs = result.logs && result.logs.length > 0 ? `Logs:\n${result.logs.join("\n")}` : undefined
  return [output, warnings, logs].filter((part) => part !== undefined && part !== "").join("\n\n")
}

function formatValue(value: CodeMode.DataValue) {
  if (typeof value === "string") return value
  return JSON.stringify(value, null, 2) ?? String(value)
}
