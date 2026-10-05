import { join } from "node:path"
import { createSpecterApp, EventLog, prepareSpecterApp } from "@specter-ts/core"
import { createJsonlEventLog, createJsonlReactionOutboxStore, createJsonlSliceStoreLayer } from "@specter-ts/jsonl"
import { createMemorySliceStoreLayer } from "@specter-ts/memory"
import type { OutboxedReaction, ReactionOutboxTransitionListener } from "@specter-ts/reaction-outbox"
import { Layer } from "effect"
import {
  completeExecution,
  createSession,
  createSessionDecision,
  DecisionStore,
  enqueuePrompt,
  failExecution,
  recordText,
  recordToolCall,
  recordToolResult,
  startExecution,
} from "./commands"
import { sessionEvents } from "./events"
import { fakeModel, type TurnModel } from "./fake-model"
import { MessagesStore, sessionMessages, sessionStatus, StatusStore } from "./queries"
import { createRunTurnState, runTurn, RunTurnStore, SessionTurns, type RunTurn, type TurnMetrics } from "./run-turn"

export const sessionAppConfig = {
  events: sessionEvents,
  slices: {
    createSession,
    enqueuePrompt,
    startExecution,
    recordText,
    recordToolCall,
    recordToolResult,
    completeExecution,
    failExecution,
    sessionMessages,
    sessionStatus,
    runTurn,
  },
} as const

// Conformance runs once per process; every Session binds this to its own Event Log.
const prepared = prepareSpecterApp(sessionAppConfig)

export type SessionAppOptions = {
  readonly root: string
  readonly sessionId: string
  readonly model?: TurnModel
  /** `jsonl` persists the Reaction cursor; `memory` replays every commit through the Reaction on open. */
  readonly reactionStore?: "jsonl" | "memory"
  readonly metrics?: TurnMetrics
  readonly onTransition?: ReactionOutboxTransitionListener<OutboxedReaction<RunTurn>>
}

export type SessionApp = Awaited<ReturnType<typeof open>>

const opened = new Map<string, Promise<SessionApp>>()

/** Opens, or reuses, the one Specter app that owns `<root>/sessions/<sessionId>`. */
export function openSessionApp(options: SessionAppOptions) {
  const sessionDir = join(options.root, "sessions", options.sessionId)
  const existing = opened.get(sessionDir)
  if (existing) return existing
  const session = open(sessionDir, options)
  opened.set(sessionDir, session)
  session.catch(() => opened.delete(sessionDir))
  return session
}

export function closeAllSessionApps() {
  return Promise.all([...opened.values()].map((session) => session.then((value) => value.close())))
}

async function open(sessionDir: string, options: SessionAppOptions) {
  // Both files are opened here rather than through scoped Layers so the Session can report a lock
  // file it took over from a worker that died without closing them.
  const outbox = createJsonlReactionOutboxStore<OutboxedReaction<RunTurn>>({ path: join(sessionDir, "outbox.jsonl") })
  const log = await Promise.try(() => createJsonlEventLog({ path: join(sessionDir, "events.jsonl") })).catch(
    (cause) => {
      outbox.close()
      throw cause
    },
  )
  const app = await createSpecterApp(
    await prepared,
    Layer.mergeAll(
      Layer.succeed(EventLog, log),
      // The transcript grows with the log and Decision/Status State is cheap to replay, so only
      // the Reaction, whose cursor must survive a restart, keeps a JSON file.
      createMemorySliceStoreLayer(DecisionStore, createSessionDecision),
      createMemorySliceStoreLayer(MessagesStore, () => ({ pending: {}, messages: [] })),
      createMemorySliceStoreLayer(StatusStore, () => ({
        created: false,
        running: null,
        queued: [],
        succeeded: 0,
        failed: 0,
      })),
      options.reactionStore === "memory"
        ? createMemorySliceStoreLayer(RunTurnStore, createRunTurnState)
        : createJsonlSliceStoreLayer(RunTurnStore, createRunTurnState, { directory: join(sessionDir, "slices") }),
      Layer.succeed(SessionTurns, {
        sessionDir,
        model: options.model ?? fakeModel(),
        outbox,
        onTransition: options.onTransition,
        metrics: options.metrics,
      }),
    ),
  ).catch((cause) => {
    outbox.close()
    log.close()
    throw cause
  })
  return {
    sessionId: options.sessionId,
    sessionDir,
    app,
    outbox,
    recoveredStaleLock: { eventLog: log.recoveredStaleLock, outbox: outbox.recoveredStaleLock },
    /** Resolves once the Session is idle with nothing queued. */
    awaitIdle: async () => {
      for await (const status of app.subscribe({ type: "sessionStatus", payload: {} }))
        if (status.status === "idle" && status.queued === 0) return status
      throw new Error("Session status subscription ended before the Session went idle")
    },
    close: async () => {
      opened.delete(sessionDir)
      // Closing the app drains a running turn first, so the outbox records its outcome.
      await app.close()
      outbox.close()
      log.close()
    },
  }
}
