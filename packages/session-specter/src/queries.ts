import { implementQuery, type SliceStoreService } from "@specter-ts/core"
import { createQuerySlice, event } from "@specter-ts/spec"
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
  toolCalled,
  toolSucceeded,
} from "./events"

export type MessagePart =
  | { type: "text"; ordinal: number; text: string }
  | {
      type: "tool"
      callId: string
      tool: string
      input: Record<string, string>
      status: "running" | "succeeded"
      output: string | null
    }

export type SessionMessage =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; executionId: string; parts: MessagePart[] }

export type SessionMessagesState = {
  pending: Record<string, string>
  messages: SessionMessage[]
}

export type SessionStatusState = {
  created: boolean
  running: string | null
  queued: string[]
  succeeded: number
  failed: number
}

export const MessagesStore = Context.Service<SliceStoreService<SessionMessagesState, SessionMessagesState, unknown>>(
  "@ocpp/session-specter/MessagesStore",
)

export const StatusStore = Context.Service<SliceStoreService<SessionStatusState, SessionStatusState, unknown>>(
  "@ocpp/session-specter/StatusStore",
)

const enqueued = event("prompt-enqueued", { promptId: "prm_1", text: "Fix the build" })
const delivered = event("prompt-delivered", { promptId: "prm_1", executionId: "exe_1" })
const started = event("execution-started", { executionId: "exe_1", promptId: "prm_1" })

export const sessionMessages = implementQuery(
  createQuerySlice("sessionMessages")
    .description("Lists delivered user prompts and assistant parts in order.")
    .scenarios(
      { description: "Returns no messages for a new Session.", given: [], when: {}, expect: [] },
      { description: "Hides queued prompts.", given: [enqueued], when: {}, expect: [] },
      {
        description: "Returns the delivered prompt, assistant text, and settled tool call.",
        given: [
          enqueued,
          delivered,
          event("text-ended", { executionId: "exe_1", messageId: "msg_1", ordinal: 0, text: "Reading." }),
          event("tool-called", {
            executionId: "exe_1",
            messageId: "msg_1",
            callId: "call_1",
            tool: "read",
            input: { path: "a.ts" },
          }),
          event("tool-succeeded", { executionId: "exe_1", callId: "call_1", output: "contents" }),
        ],
        when: {},
        expect: [
          { id: "prm_1", role: "user", text: "Fix the build" },
          {
            id: "msg_1",
            role: "assistant",
            executionId: "exe_1",
            parts: [
              { type: "text", ordinal: 0, text: "Reading." },
              {
                type: "tool",
                callId: "call_1",
                tool: "read",
                input: { path: "a.ts" },
                status: "succeeded",
                output: "contents",
              },
            ],
          },
        ],
      },
    ),
)
  .inputSchema(z.object({}))
  .outputSchema<SessionMessage[]>()
  .store(MessagesStore)
  .apply(promptEnqueued, async (event, state) => {
    state.pending[event.payload.promptId] = event.payload.text
  })
  .apply(promptDelivered, async (event, state) => {
    state.messages.push({ id: event.payload.promptId, role: "user", text: state.pending[event.payload.promptId] ?? "" })
    delete state.pending[event.payload.promptId]
  })
  .apply(textEnded, async (event, state) => {
    assistant(state, event.payload).parts.push({ type: "text", ordinal: event.payload.ordinal, text: event.payload.text })
  })
  .apply(toolCalled, async (event, state) => {
    assistant(state, event.payload).parts.push({
      type: "tool",
      callId: event.payload.callId,
      tool: event.payload.tool,
      input: event.payload.input,
      status: "running",
      output: null,
    })
  })
  .apply(toolSucceeded, async (event, state) => {
    const part = state.messages
      .flatMap((message) => (message.role === "assistant" ? message.parts : []))
      .find((part) => part.type === "tool" && part.callId === event.payload.callId)
    if (part?.type !== "tool") return
    part.status = "succeeded"
    part.output = event.payload.output
  })
  .handle(async (_query, state) => state.messages)

function assistant(state: SessionMessagesState, payload: { executionId: string; messageId: string }) {
  const existing = state.messages.find((message) => message.id === payload.messageId)
  if (existing?.role === "assistant") return existing
  const created = { id: payload.messageId, role: "assistant" as const, executionId: payload.executionId, parts: [] }
  state.messages.push(created)
  return created
}

export const sessionStatus = implementQuery(
  createQuerySlice("sessionStatus")
    .description("Reports whether the Session is running and how many prompts wait.")
    .scenarios(
      {
        description: "Reports a missing Session.",
        given: [],
        when: {},
        expect: { status: "missing", executionId: null, queued: 0, succeeded: 0, failed: 0 },
      },
      {
        description: "Reports a queued prompt on an idle Session.",
        given: [event("session-created", { sessionId: "ses_1" }), enqueued],
        when: {},
        expect: { status: "idle", executionId: null, queued: 1, succeeded: 0, failed: 0 },
      },
      {
        description: "Reports a running execution and the remaining queue.",
        given: [
          event("session-created", { sessionId: "ses_1" }),
          enqueued,
          started,
          delivered,
          event("prompt-enqueued", { promptId: "prm_2", text: "More" }),
        ],
        when: {},
        expect: { status: "running", executionId: "exe_1", queued: 1, succeeded: 0, failed: 0 },
      },
      {
        description: "Counts terminal executions.",
        given: [
          event("session-created", { sessionId: "ses_1" }),
          enqueued,
          started,
          delivered,
          event("execution-succeeded", { executionId: "exe_1" }),
          event("prompt-enqueued", { promptId: "prm_2", text: "More" }),
          event("execution-started", { executionId: "exe_2", promptId: "prm_2" }),
          event("prompt-delivered", { promptId: "prm_2", executionId: "exe_2" }),
          event("execution-failed", { executionId: "exe_2", error: "Provider overloaded" }),
        ],
        when: {},
        expect: { status: "idle", executionId: null, queued: 0, succeeded: 1, failed: 1 },
      },
    ),
)
  .inputSchema(z.object({}))
  .outputSchema<{
    status: "missing" | "idle" | "running"
    executionId: string | null
    queued: number
    succeeded: number
    failed: number
  }>()
  .store(StatusStore)
  .apply(sessionCreated, async (_event, state) => {
    state.created = true
  })
  .apply(promptEnqueued, async (event, state) => {
    state.queued.push(event.payload.promptId)
  })
  .apply(promptDelivered, async (event, state) => {
    state.queued = state.queued.filter((id) => id !== event.payload.promptId)
  })
  .apply(executionStarted, async (event, state) => {
    state.running = event.payload.executionId
  })
  .apply(executionSucceeded, async (_event, state) => {
    state.running = null
    state.succeeded += 1
  })
  .apply(executionFailed, async (_event, state) => {
    state.running = null
    state.failed += 1
  })
  .handle(async (_query, state) => ({
    status: state.created ? (state.running ? "running" : "idle") : "missing",
    executionId: state.running,
    queued: state.queued.length,
    succeeded: state.succeeded,
    failed: state.failed,
  }))
