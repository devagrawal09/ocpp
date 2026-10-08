import { createEventDefinition } from "@specter-ts/core"
import { z } from "zod"

// One Specter app owns one Session, so payloads omit the session ID that OC++ events
// carry as their aggregate key. Names follow `session.*` in @ocpp/schema/session-event.

export const sessionCreated = createEventDefinition("session-created", z.object({ sessionId: z.string() }))

/** Durable prompt admission, like `session.inbox.enqueued`. */
export const promptEnqueued = createEventDefinition(
  "prompt-enqueued",
  z.object({ promptId: z.string(), text: z.string() }),
)

/** Consumes the queued prompt and makes it a visible user message, like `session.inbox.delivered`. */
export const promptDelivered = createEventDefinition(
  "prompt-delivered",
  z.object({ promptId: z.string(), executionId: z.string() }),
)

export const executionStarted = createEventDefinition(
  "execution-started",
  z.object({ executionId: z.string(), promptId: z.string() }),
)

export const executionSucceeded = createEventDefinition(
  "execution-succeeded",
  z.object({ executionId: z.string() }),
)

export const executionFailed = createEventDefinition(
  "execution-failed",
  z.object({ executionId: z.string(), error: z.string() }),
)

export const textStarted = createEventDefinition(
  "text-started",
  z.object({ executionId: z.string(), messageId: z.string(), ordinal: z.number().int().nonnegative() }),
)

/** Replayable full-value boundary. Deltas live only in the per-step delta log. */
export const textEnded = createEventDefinition(
  "text-ended",
  z.object({
    executionId: z.string(),
    messageId: z.string(),
    ordinal: z.number().int().nonnegative(),
    text: z.string(),
  }),
)

export const toolCalled = createEventDefinition(
  "tool-called",
  z.object({
    executionId: z.string(),
    messageId: z.string(),
    callId: z.string(),
    tool: z.string(),
    input: z.record(z.string(), z.string()),
  }),
)

export const toolSucceeded = createEventDefinition(
  "tool-succeeded",
  z.object({ executionId: z.string(), callId: z.string(), output: z.string() }),
)

export const sessionEvents = [
  sessionCreated,
  promptEnqueued,
  promptDelivered,
  executionStarted,
  executionSucceeded,
  executionFailed,
  textStarted,
  textEnded,
  toolCalled,
  toolSucceeded,
] as const
