import { implementCommand, type EventForDefinition, type SliceStoreService } from "@specter-ts/core"
import { createCommandSlice, event } from "@specter-ts/spec"
import { Context } from "effect"
import { z } from "zod"
import {
  executionFailed,
  executionStarted,
  executionSucceeded,
  promptDelivered,
  promptEnqueued,
  sessionCreated,
  textEnded,
  textStarted,
  toolCalled,
  toolSucceeded,
} from "./events"

/** Decision State shared by the Command Slices; each Slice folds only the Events it registers. */
export type SessionDecision = {
  sessionId?: string
  prompts: Record<string, "queued" | "delivered">
  running?: string
}

export const createSessionDecision = (): SessionDecision => ({ prompts: {} })

export const DecisionStore = Context.Service<SliceStoreService<SessionDecision, SessionDecision, unknown>>(
  "@ocpp/session-specter/DecisionStore",
)

const created = event("session-created", { sessionId: "ses_1" })
const enqueued = event("prompt-enqueued", { promptId: "prm_1", text: "Fix the build" })
const started = [
  event("execution-started", { executionId: "exe_1", promptId: "prm_1" }),
  event("prompt-delivered", { promptId: "prm_1", executionId: "exe_1" }),
] as const
const running = event("execution-started", { executionId: "exe_1", promptId: "prm_1" })
const succeeded = event("execution-succeeded", { executionId: "exe_1" })
const failed = event("execution-failed", { executionId: "exe_1", error: "Provider overloaded" })

const onCreated = async (event: EventForDefinition<typeof sessionCreated>, state: SessionDecision) => {
  state.sessionId = event.payload.sessionId
}
const onEnqueued = async (event: EventForDefinition<typeof promptEnqueued>, state: SessionDecision) => {
  state.prompts[event.payload.promptId] = "queued"
}
const onDelivered = async (event: EventForDefinition<typeof promptDelivered>, state: SessionDecision) => {
  state.prompts[event.payload.promptId] = "delivered"
}
const onStarted = async (event: EventForDefinition<typeof executionStarted>, state: SessionDecision) => {
  state.running = event.payload.executionId
}
const onEnded = async (_event: unknown, state: SessionDecision) => {
  state.running = undefined
}

function requireRunning(state: SessionDecision, executionId: string) {
  if (state.running !== executionId) throw new Error("Execution is not running")
}

export const createSession = implementCommand(
  createCommandSlice("createSession")
    .description("Creates the Session that owns this app.")
    .scenarios(
      { description: "Creates the Session.", given: [], when: { sessionId: "ses_1" }, expect: [created] },
      {
        description: "Rejects a second creation.",
        given: [created],
        when: { sessionId: "ses_1" },
        expect: [],
        reject: { reason: "Session already exists" },
      },
    ),
)
  .inputSchema(z.object({ sessionId: z.string() }))
  .store(DecisionStore)
  .apply(sessionCreated, onCreated)
  .handle(async (command, state) => {
    if (state.sessionId) throw new Error("Session already exists")
    return [sessionCreated.create(command)]
  })

export const enqueuePrompt = implementCommand(
  createCommandSlice("enqueuePrompt")
    .description("Admits a prompt into the durable inbox.")
    .scenarios(
      {
        description: "Admits the prompt.",
        given: [created],
        when: { promptId: "prm_1", text: "Fix the build" },
        expect: [enqueued],
      },
      {
        description: "Rejects a prompt before the Session exists.",
        given: [],
        when: { promptId: "prm_1", text: "Fix the build" },
        expect: [],
        reject: { reason: "Session does not exist" },
      },
      {
        description: "Rejects a reused prompt ID.",
        given: [created, enqueued],
        when: { promptId: "prm_1", text: "Different text" },
        expect: [],
        reject: { reason: "Prompt already admitted" },
      },
    ),
)
  .inputSchema(z.object({ promptId: z.string(), text: z.string() }))
  .store(DecisionStore)
  .apply(sessionCreated, onCreated)
  .apply(promptEnqueued, onEnqueued)
  .handle(async (command, state) => {
    if (!state.sessionId) throw new Error("Session does not exist")
    if (state.prompts[command.promptId]) throw new Error("Prompt already admitted")
    return [promptEnqueued.create(command)]
  })

export const startExecution = implementCommand(
  createCommandSlice("startExecution")
    .description("Starts one execution and delivers the queued prompt it serves.")
    .scenarios(
      {
        description: "Starts the execution and delivers the prompt.",
        given: [enqueued],
        when: { executionId: "exe_1", promptId: "prm_1" },
        expect: started,
      },
      {
        description: "Rejects a second concurrent execution.",
        given: [enqueued, ...started, event("prompt-enqueued", { promptId: "prm_2", text: "More" })],
        when: { executionId: "exe_2", promptId: "prm_2" },
        expect: [],
        reject: { reason: "Execution already running" },
      },
      {
        description: "Starts the next execution after the previous one succeeded.",
        given: [enqueued, ...started, event("prompt-enqueued", { promptId: "prm_2", text: "More" }), succeeded],
        when: { executionId: "exe_2", promptId: "prm_2" },
        expect: [
          event("execution-started", { executionId: "exe_2", promptId: "prm_2" }),
          event("prompt-delivered", { promptId: "prm_2", executionId: "exe_2" }),
        ],
      },
      {
        description: "Starts the next execution after the previous one failed.",
        given: [enqueued, ...started, event("prompt-enqueued", { promptId: "prm_2", text: "More" }), failed],
        when: { executionId: "exe_2", promptId: "prm_2" },
        expect: [
          event("execution-started", { executionId: "exe_2", promptId: "prm_2" }),
          event("prompt-delivered", { promptId: "prm_2", executionId: "exe_2" }),
        ],
      },
      {
        description: "Rejects a prompt that is not queued.",
        given: [enqueued, ...started, succeeded],
        when: { executionId: "exe_2", promptId: "prm_1" },
        expect: [],
        reject: { reason: "Prompt is not queued" },
      },
    ),
)
  .inputSchema(z.object({ executionId: z.string(), promptId: z.string() }))
  .store(DecisionStore)
  .apply(promptEnqueued, onEnqueued)
  .apply(promptDelivered, onDelivered)
  .apply(executionStarted, onStarted)
  .apply(executionSucceeded, onEnded)
  .apply(executionFailed, onEnded)
  .handle(async (command, state) => {
    if (state.running) throw new Error("Execution already running")
    if (state.prompts[command.promptId] !== "queued") throw new Error("Prompt is not queued")
    return [
      executionStarted.create(command),
      promptDelivered.create({ promptId: command.promptId, executionId: command.executionId }),
    ]
  })

export const recordText = implementCommand(
  createCommandSlice("recordText")
    .description("Records one completed assistant text part.")
    .scenarios(
      {
        description: "Records the text part.",
        given: [running],
        when: { executionId: "exe_1", messageId: "msg_1", ordinal: 0, text: "Done." },
        expect: [
          event("text-started", { executionId: "exe_1", messageId: "msg_1", ordinal: 0 }),
          event("text-ended", { executionId: "exe_1", messageId: "msg_1", ordinal: 0, text: "Done." }),
        ],
      },
      {
        description: "Rejects text for an execution that is not running.",
        given: [running, succeeded],
        when: { executionId: "exe_1", messageId: "msg_1", ordinal: 0, text: "Late." },
        expect: [],
        reject: { reason: "Execution is not running" },
      },
      {
        description: "Rejects text after the execution failed.",
        given: [running, failed],
        when: { executionId: "exe_1", messageId: "msg_1", ordinal: 0, text: "Late." },
        expect: [],
        reject: { reason: "Execution is not running" },
      },
    ),
)
  .inputSchema(
    z.object({ executionId: z.string(), messageId: z.string(), ordinal: z.number().int().nonnegative(), text: z.string() }),
  )
  .store(DecisionStore)
  .apply(executionStarted, onStarted)
  .apply(executionSucceeded, onEnded)
  .apply(executionFailed, onEnded)
  .handle(async (command, state) => {
    requireRunning(state, command.executionId)
    return [
      textStarted.create({ executionId: command.executionId, messageId: command.messageId, ordinal: command.ordinal }),
      textEnded.create(command),
    ]
  })

export const recordToolCall = implementCommand(
  createCommandSlice("recordToolCall")
    .description("Records a tool call requested by the model.")
    .scenarios(
      {
        description: "Records the tool call.",
        given: [running],
        when: { executionId: "exe_1", messageId: "msg_1", callId: "call_1", tool: "read", input: { path: "a.ts" } },
        expect: [
          event("tool-called", {
            executionId: "exe_1",
            messageId: "msg_1",
            callId: "call_1",
            tool: "read",
            input: { path: "a.ts" },
          }),
        ],
      },
      {
        description: "Rejects a tool call after the execution succeeded.",
        given: [running, succeeded],
        when: { executionId: "exe_1", messageId: "msg_1", callId: "call_1", tool: "read", input: {} },
        expect: [],
        reject: { reason: "Execution is not running" },
      },
      {
        description: "Rejects a tool call after the execution failed.",
        given: [running, failed],
        when: { executionId: "exe_1", messageId: "msg_1", callId: "call_1", tool: "read", input: {} },
        expect: [],
        reject: { reason: "Execution is not running" },
      },
    ),
)
  .inputSchema(
    z.object({
      executionId: z.string(),
      messageId: z.string(),
      callId: z.string(),
      tool: z.string(),
      input: z.record(z.string(), z.string()),
    }),
  )
  .store(DecisionStore)
  .apply(executionStarted, onStarted)
  .apply(executionSucceeded, onEnded)
  .apply(executionFailed, onEnded)
  .handle(async (command, state) => {
    requireRunning(state, command.executionId)
    return [toolCalled.create(command)]
  })

export const recordToolResult = implementCommand(
  createCommandSlice("recordToolResult")
    .description("Records a successful tool result.")
    .scenarios(
      {
        description: "Records the result.",
        given: [running],
        when: { executionId: "exe_1", callId: "call_1", output: "contents" },
        expect: [event("tool-succeeded", { executionId: "exe_1", callId: "call_1", output: "contents" })],
      },
      {
        description: "Rejects a result after the execution ended.",
        given: [running, succeeded],
        when: { executionId: "exe_1", callId: "call_1", output: "contents" },
        expect: [],
        reject: { reason: "Execution is not running" },
      },
      {
        description: "Rejects a result after the execution failed.",
        given: [running, failed],
        when: { executionId: "exe_1", callId: "call_1", output: "contents" },
        expect: [],
        reject: { reason: "Execution is not running" },
      },
    ),
)
  .inputSchema(z.object({ executionId: z.string(), callId: z.string(), output: z.string() }))
  .store(DecisionStore)
  .apply(executionStarted, onStarted)
  .apply(executionSucceeded, onEnded)
  .apply(executionFailed, onEnded)
  .handle(async (command, state) => {
    requireRunning(state, command.executionId)
    return [toolSucceeded.create(command)]
  })

export const completeExecution = implementCommand(
  createCommandSlice("completeExecution")
    .description("Ends the running execution successfully.")
    .scenarios(
      { description: "Completes the execution.", given: [running], when: { executionId: "exe_1" }, expect: [succeeded] },
      {
        description: "Rejects completing twice.",
        given: [running, succeeded],
        when: { executionId: "exe_1" },
        expect: [],
        reject: { reason: "Execution is not running" },
      },
      {
        description: "Rejects completing a failed execution.",
        given: [running, failed],
        when: { executionId: "exe_1" },
        expect: [],
        reject: { reason: "Execution is not running" },
      },
    ),
)
  .inputSchema(z.object({ executionId: z.string() }))
  .store(DecisionStore)
  .apply(executionStarted, onStarted)
  .apply(executionSucceeded, onEnded)
  .apply(executionFailed, onEnded)
  .handle(async (command, state) => {
    requireRunning(state, command.executionId)
    return [executionSucceeded.create(command)]
  })

export const failExecution = implementCommand(
  createCommandSlice("failExecution")
    .description("Ends the running execution with an error.")
    .scenarios(
      {
        description: "Fails the execution.",
        given: [running],
        when: { executionId: "exe_1", error: "Provider overloaded" },
        expect: [failed],
      },
      {
        description: "Rejects failing a succeeded execution.",
        given: [running, succeeded],
        when: { executionId: "exe_1", error: "Provider overloaded" },
        expect: [],
        reject: { reason: "Execution is not running" },
      },
      {
        description: "Rejects failing twice.",
        given: [running, failed],
        when: { executionId: "exe_1", error: "Provider overloaded" },
        expect: [],
        reject: { reason: "Execution is not running" },
      },
    ),
)
  .inputSchema(z.object({ executionId: z.string(), error: z.string() }))
  .store(DecisionStore)
  .apply(executionStarted, onStarted)
  .apply(executionSucceeded, onEnded)
  .apply(executionFailed, onEnded)
  .handle(async (command, state) => {
    requireRunning(state, command.executionId)
    return [executionFailed.create(command)]
  })
